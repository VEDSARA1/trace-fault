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

// ABI cache. key = address (lowercase) → one of:
//   { promise }              an in-flight fetch (concurrent callers dedup on it)
//   { value, expiresAt }     a resolved result
//
// value is a parsed ABI array (verified) or null (confirmed unverified).
// expiresAt is null for verified ABIs — contract bytecode is immutable, so a
// verified ABI never goes stale and is cached for the process lifetime. null
// (unverified) entries carry a timestamp and expire after UNVERIFIED_TTL_MS, so
// a contract that gets verified later is eventually picked up on re-fetch.
// Transient errors are NEVER cached — they should be retried on the next call.
const abiCache = new Map();
const UNVERIFIED_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Address-type cache, same expiry reasoning as above: 'contract' is permanent
// (deployed code never goes away for our purposes), while 'wallet' carries a TTL
// because an empty address can later receive a deployment (notably via CREATE2).
const addressTypeCache = new Map();
const EIP7702_PREFIX = '0xef0100'; // delegation designator on an EOA

// Exported for tests: the spacing logic is worth exercising in isolation,
// without going through the shared module-level queue.
export class RequestQueue {
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
    // When the last request actually STARTED. Spacing is measured from this, not
    // from queue occupancy — see processQueue.
    this.lastRunAt = 0;
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

      // Space from when the last request STARTED, not merely between items that
      // happen to be queued together. Callers here are sequential (the frontend
      // awaits each trace), so each arrives to an empty queue — gating the delay
      // on queue occupancy meant the throttle never engaged at all and we ran as
      // fast as the network allowed, straight past Etherscan's per-second limit.
      // Clamped to delayMs: if the clock jumps backwards (NTP correction, or a
      // test faking timers) sinceLast goes negative and an unclamped
      // `delayMs - sinceLast` would sleep for the length of the jump, wedging
      // the queue. Never wait longer than a single interval.
      const sinceLast = Date.now() - this.lastRunAt;
      const wait = Math.min(Math.max(this.delayMs - sinceLast, 0), this.delayMs);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.lastRunAt = Date.now();

      try {
        const result = await task();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }

    this.isProcessing = false;
  }
}

// 250ms ≈ 4 req/sec, just under Etherscan's 5/sec free tier. Configurable so a
// paid tier can go faster, and so tests can disable the wait entirely.
const QUEUE_DELAY_MS = Number(process.env.ETHERSCAN_QUEUE_DELAY_MS ?? 250);
const etherscanQueue = new RequestQueue(QUEUE_DELAY_MS);

// Etherscan often returns HTTP 200 with a rate-limit message in the body
// instead of a real 429, so we sniff the parsed JSON as well.
const RATE_LIMIT_RX = /rate limit|max calls per sec|max rate/i;
function looksLikeRateLimit(json) {
  if (!json) return false;
  // Etherscan signals throttling with an error-shaped response — status "0"
  // (the NOTOK envelope it uses across REST *and* the proxy/eth_call module) —
  // carrying the rate-limit text in `message` or `result`.
  //
  // We deliberately gate on status "0" and do NOT inspect `json.error.message`
  // or a success-body `result`: for eth_call those hold the contract's own
  // revert reason / return data, which is arbitrary and could legitimately
  // contain "rate limit" (e.g. a revert string, or an ABI error named
  // RateLimitExceeded), causing a false 429.
  if (json.status !== '0') return false;
  if (typeof json.result === 'string' && RATE_LIMIT_RX.test(json.result)) return true;
  if (typeof json.message === 'string' && RATE_LIMIT_RX.test(json.message)) return true;
  return false;
}

// Bounded retry for rate limiting. Spacing alone can't prevent every 429 — the
// budget is shared with other callers and each trace may spend two calls — so a
// throttled request backs off and retries rather than being lost. Because queue
// tasks run serially, sleeping here backs off the whole pipeline, which is what
// we want. Mutable so tests can shorten or disable it.
export const retryPolicy = {
  retries: Number(process.env.ETHERSCAN_RATE_LIMIT_RETRIES ?? 3),
  baseDelayMs: Number(process.env.ETHERSCAN_RETRY_BASE_MS ?? 300),
};

const fetchFromEtherscan = async (url) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (err) {
      if (!(err instanceof RateLimitError) || attempt >= retryPolicy.retries) throw err;
      const wait = retryPolicy.baseDelayMs * 2 ** attempt;
      console.warn(`[etherscan] rate limited; backing off ${wait}ms (attempt ${attempt + 1}/${retryPolicy.retries})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
};

const fetchOnce = async (url) => {
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

// Normalize a decimal-or-hex quantity string to 0x-hex. Shared by blockNumber
// and gas so both encode identically. Throws EtherscanError on garbage input —
// do NOT silently fall back to a default: that would send a real request with
// the wrong value and no indication anything was wrong. Validation upstream
// (validateTrace) should prevent this from ever happening, but if it's ever
// reached anyway, fail loudly instead of guessing.
function toHexQuantity(value, label) {
  let hex = String(value);
  if (!hex.startsWith('0x')) {
    try {
      hex = `0x${BigInt(hex).toString(16)}`;
    } catch (err) {
      throw new EtherscanError(`Invalid ${label} "${value}": ${err.message}`);
    }
  }
  return hex;
}

// Params arrive as an object: the set is expected to grow (see the `value` note
// below), and positional optionals would force undefined placeholders as it does.
export const getTrace = async ({ to, data, blockNumber, from, gas }) => {
  const apiKey = requireApiKey();

  const blockHex = toHexQuantity(blockNumber, 'blockNumber');

  // Replay fidelity: forward the original sender so msg.sender-gated paths
  // (onlyOwner etc.) reproduce the real revert instead of running as 0x0.
  // Both params are optional — when absent the URL is byte-for-byte what it
  // was before they existed. Deliberately NOT forwarding `value`: some nodes
  // validate value against the sender's CURRENT balance in eth_call and would
  // inject false "insufficient balance" reverts.
  let extra = '';
  if (from) extra += `&from=${from}`;
  if (gas) extra += `&gas=${toHexQuantity(gas, 'gas')}`;

  const traceUrl = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_call&to=${to}&data=${data}&tag=${blockHex}${extra}&apikey=${apiKey}`;
  return etherscanQueue.enqueue(() => fetchFromEtherscan(traceUrl));
};

/**
 * Classify an address as 'wallet' (EOA, no code) or 'contract', via eth_getCode.
 * The distinction drives analysis semantics: a wallet's failed transactions are
 * the ones it SENT, whereas a contract's are the failed calls made TO it.
 * Cached; errors are never cached so a transient failure retries.
 *
 * @returns {Promise<'wallet'|'contract'>}
 */
export const getAddressType = async (address) => {
  const key = address.toLowerCase();
  const cached = addressTypeCache.get(key);
  if (cached) {
    if (cached.promise) return await cached.promise;
    if (cached.expiresAt === null || cached.expiresAt > Date.now()) return cached.value;
    addressTypeCache.delete(key);
  }

  const fetchPromise = (async () => {
    const apiKey = requireApiKey();
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getCode&address=${address}&tag=latest&apikey=${apiKey}`;
    const json = await etherscanQueue.enqueue(() => fetchFromEtherscan(url));
    const code = typeof json?.result === 'string' ? json.result : '0x';

    // Empty code — a plain externally owned account.
    if (!code || code === '0x') return 'wallet';

    // EIP-7702 delegation designator: 0xef0100 || <20-byte address>. Since
    // Pectra an EOA can delegate to a contract, so eth_getCode returns code for
    // an account that is still a wallet — it has a nonce and sends its own
    // transactions. Treating it as a contract would flip the analysis semantics
    // (inbound calls instead of sent transactions) for real, active wallets.
    if (code.toLowerCase().startsWith(EIP7702_PREFIX)) return 'wallet';

    return 'contract';
  })();

  addressTypeCache.set(key, { promise: fetchPromise });

  try {
    const value = await fetchPromise;
    const expiresAt = value === 'contract' ? null : Date.now() + UNVERIFIED_TTL_MS;
    addressTypeCache.set(key, { value, expiresAt });
    return value;
  } catch (err) {
    addressTypeCache.delete(key);
    throw err;
  }
};

/**
 * Fetch a transaction receipt (eth_getTransactionReceipt).
 * Returns the JSON-RPC envelope; `result` is null if the hash is unknown.
 */
export const getTransactionReceipt = async (hash) => {
  const apiKey = requireApiKey();
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getTransactionReceipt&txhash=${hash}&apikey=${apiKey}`;
  return etherscanQueue.enqueue(() => fetchFromEtherscan(url));
};

/**
 * Fetch a transaction by hash (eth_getTransactionByHash).
 * Returns the JSON-RPC envelope; `result` is null if the hash is unknown.
 */
export const getTransactionByHash = async (hash) => {
  const apiKey = requireApiKey();
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_getTransactionByHash&txhash=${hash}&apikey=${apiKey}`;
  return etherscanQueue.enqueue(() => fetchFromEtherscan(url));
};

/**
 * Fetch the verified ABI for a contract from Etherscan.
 * Returns a parsed ABI array, or null if the contract is confirmed unverified.
 * Throws ConfigError / RateLimitError / EtherscanError on failure — nothing is cached in that case.
 */
export const getAbi = async (address) => {
  const key = address.toLowerCase();

  const cached = abiCache.get(key);
  if (cached) {
    // In-flight fetch: dedup by awaiting the same promise.
    if (cached.promise) return await cached.promise;
    // Resolved: verified entries never expire (expiresAt null); unverified
    // entries are honored until their TTL lapses.
    if (cached.expiresAt === null || cached.expiresAt > Date.now()) {
      return cached.value;
    }
    // Stale unverified entry — drop it and re-fetch below.
    abiCache.delete(key);
  }

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

  abiCache.set(key, { promise: fetchPromise });

  try {
    const result = await fetchPromise;
    // Verified (array) → cache forever; unverified (null) → 24h TTL.
    const expiresAt = result === null ? Date.now() + UNVERIFIED_TTL_MS : null;
    abiCache.set(key, { value: result, expiresAt });
    return result;
  } catch (err) {
    abiCache.delete(key);
    throw err;
  }
};
