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
  constructor(delayMs) {
    this.delayMs = delayMs;
    this.queue = [];
    this.isProcessing = false;
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const { task, resolve, reject } = this.queue.shift();
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
  try {
    response = await fetch(url);
  } catch (err) {
    throw new EtherscanError(`Network error contacting Etherscan: ${err.message}`);
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

  let blockHex = blockNumber;
  if (!blockHex.startsWith('0x')) {
    blockHex = `0x${parseInt(blockNumber, 10).toString(16)}`;
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
  if (abiCache.has(key)) return abiCache.get(key);

  const apiKey = requireApiKey();
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getabi&address=${address}&apikey=${apiKey}`;

  const json = await etherscanQueue.enqueue(() => fetchFromEtherscan(url));

  if (json.status !== '1' || !json.result || json.result === 'Contract source code not verified') {
    abiCache.set(key, null);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(json.result);
  } catch (err) {
    throw new EtherscanError(`Etherscan returned malformed ABI JSON: ${err.message}`);
  }
  abiCache.set(key, parsed);
  return parsed;
};
