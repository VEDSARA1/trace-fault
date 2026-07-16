import dotenv from 'dotenv';
dotenv.config();

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class EtherscanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EtherscanError';
  }
}

// address (lowercase) → parsed ABI array | null
// null means the contract was checked and is confirmed unverified.
// Transient errors are NOT cached — they should be retried on the next call.
const abiCache = new Map();

class RequestQueue {
  /**
   * @param {number} delayMs   Spacing enforced between successive requests.
   * @param {object} [opts]
   * @param {number} [opts.maxQueue]   Max tasks allowed to wait; beyond this, enqueue is rejected (backpressure).
   * @param {number} [opts.maxWaitMs]  Max time a task may sit queued before it starts; exceeded → rejected.
   */
  constructor(delayMs, { maxQueue = 50, maxWaitMs = 15000 } = {}) {
    this.delayMs = delayMs;
    this.maxQueue = maxQueue;
    this.maxWaitMs = maxWaitMs;
    this.queue = [];
    this.isProcessing = false;
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      // Backpressure: don't let the queue grow without bound. A caller that
      // arrives when we're already saturated fails fast with a rate-limit
      // signal rather than waiting an unbounded amount of time.
      if (this.queue.length >= this.maxQueue) {
        reject(new RateLimitError('Server is busy (request queue full). Please retry shortly.'));
        return;
      }
      this.queue.push({ task, resolve, reject, enqueuedAt: Date.now() });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const { task, resolve, reject, enqueuedAt } = this.queue.shift();

      // The per-request fetch timeout only starts once a task RUNS. A task that
      // waited too long in line would otherwise hang the client far past that
      // timeout, so drop it here instead of starting a now-stale request.
      if (Date.now() - enqueuedAt > this.maxWaitMs) {
        reject(new EtherscanError('Timed out waiting in the request queue.'));
        continue;
      }

      try {
        const result = await task();
        resolve(result);
      } catch (error) {
        reject(error);
      }

      if (this.queue.length > 0) {
        await new Promise(r => setTimeout(r, this.delayMs));
      }
    }

    this.isProcessing = false;
  }
}

const etherscanQueue = new RequestQueue(250);

// Etherscan often returns HTTP 200 with a rate-limit message in the body
// instead of a real 429, so we sniff the parsed JSON as well.
const RATE_LIMIT_RX = /rate limit|max calls per sec|max rate/i;
function looksLikeRateLimit(json) {
  if (!json) return false;
  if (typeof json.result === 'string' && RATE_LIMIT_RX.test(json.result)) return true;
  if (typeof json.message === 'string' && RATE_LIMIT_RX.test(json.message)) return true;
  if (typeof json.error?.message === 'string' && RATE_LIMIT_RX.test(json.error.message)) return true;
  return false;
}

const fetchFromEtherscan = async (url) => {
  let response;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new EtherscanError('Request to Etherscan timed out after 10s');
    }
    throw new EtherscanError(`Network error contacting Etherscan: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 429) {
    throw new RateLimitError('Etherscan rate limit reached (HTTP 429)');
  }
  if (!response.ok) {
    throw new EtherscanError(`Etherscan HTTP error, status ${response.status}`);
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    throw new EtherscanError(`Failed to parse Etherscan response: ${err.message}`);
  }

  if (looksLikeRateLimit(json)) {
    throw new RateLimitError('Etherscan rate limit reached');
  }

  return json;
};

function requireApiKey() {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) throw new ConfigError('ETHERSCAN_API_KEY is not configured');
  return apiKey;
}

export const getTransactions = async (address) => {
  const apiKey = requireApiKey();
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&page=1&offset=500&apikey=${apiKey}`;
  return etherscanQueue.enqueue(() => fetchFromEtherscan(url));
};

export const getTrace = async (to, data, blockNumber) => {
  const apiKey = requireApiKey();

  let blockHex = String(blockNumber);
  if (!blockHex.startsWith('0x')) {
    try {
      blockHex = `0x${BigInt(blockHex).toString(16)}`;
    } catch (err) {
      // Do NOT silently fall back to block 0 — that would send a real request
      // for the wrong block with no indication anything was wrong. Validation
      // upstream (validateTrace) should prevent this from ever happening, but
      // if it's ever reached anyway, fail loudly instead of guessing.
      throw new EtherscanError(`Invalid blockNumber "${blockNumber}": ${err.message}`);
    }
  }

  const traceUrl = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_call&to=${to}&data=${data}&tag=${blockHex}&apikey=${apiKey}`;
  return etherscanQueue.enqueue(() => fetchFromEtherscan(traceUrl));
};

/**
 * Fetch the verified ABI for a contract from Etherscan.
 * Returns a parsed ABI array, or null if the contract is confirmed unverified.
 * Throws ConfigError / RateLimitError / EtherscanError on failure — nothing is cached in that case.
 */
export const getAbi = async (address) => {
  const key = address.toLowerCase();
  if (abiCache.has(key)) return await abiCache.get(key);

  const fetchPromise = (async () => {
    const apiKey = requireApiKey();
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getabi&address=${address}&apikey=${apiKey}`;

    const json = await etherscanQueue.enqueue(() => fetchFromEtherscan(url));

    if (json.status !== '1' || !json.result || json.result === 'Contract source code not verified') {
      return null;
    }

    try {
      return JSON.parse(json.result);
    } catch (err) {
      throw new EtherscanError(`Etherscan returned malformed ABI JSON: ${err.message}`);
    }
  })();

  abiCache.set(key, fetchPromise);

  try {
    const result = await fetchPromise;
    abiCache.set(key, result);
    return result;
  } catch (err) {
    abiCache.delete(key);
    throw err;
  }
};
