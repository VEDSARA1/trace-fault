import dotenv from 'dotenv';
dotenv.config();

// In-memory ABI cache:  address (lowercase) → parsed ABI array | null
// null means the contract was checked but is unverified / fetch failed.
const abiCache = new Map();

// Simple promise-based queue for throttling Etherscan requests globally
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
      
      // Enforce the delay before processing the next request
      if (this.queue.length > 0) {
        await new Promise(r => setTimeout(r, this.delayMs));
      }
    }
    
    this.isProcessing = false;
  }
}

// 250ms delay queue to respect free tier (5 req / sec limit max)
const etherscanQueue = new RequestQueue(250);

const fetchFromEtherscan = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Etherscan HTTP error! status: ${response.status}`);
  }
  return await response.json();
};

export const getTransactions = async (address) => {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) throw new Error('ETHERSCAN_API_KEY is not configured');

  const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&page=1&offset=500&apikey=${apiKey}`;
  
  // Transaction fetch might not need to be strictly queued, but it's safer to queue it as well
  return etherscanQueue.enqueue(() => fetchFromEtherscan(url));
};

export const getTrace = async (to, data, blockNumber) => {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) throw new Error('ETHERSCAN_API_KEY is not configured');

  let blockHex = blockNumber;
  if (!blockHex.startsWith('0x')) {
    blockHex = `0x${parseInt(blockNumber, 10).toString(16)}`;
  }

  const traceUrl = `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_call&to=${to}&data=${data}&tag=${blockHex}&apikey=${apiKey}`;
  
  // Enqueue the trace request to ensure at least 250ms spacing between calls
  return etherscanQueue.enqueue(() => fetchFromEtherscan(traceUrl));
};

/**
 * Fetch the verified ABI for a contract from Etherscan.
 * Returns a parsed ABI array, or null if the contract is unverified / fetch fails.
 * Results are cached in memory for the lifetime of the server process.
 */
export const getAbi = async (address) => {
  const key = address.toLowerCase();

  if (abiCache.has(key)) return abiCache.get(key);

  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) throw new Error('ETHERSCAN_API_KEY is not configured');

  const url = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getabi&address=${address}&apikey=${apiKey}`;

  try {
    const json = await etherscanQueue.enqueue(() => fetchFromEtherscan(url));

    if (json.status !== '1' || !json.result || json.result === 'Contract source code not verified') {
      // Contract is unverified – cache null so we don't hammer the API again
      abiCache.set(key, null);
      return null;
    }

    const parsed = JSON.parse(json.result);
    abiCache.set(key, parsed);
    return parsed;
  } catch (err) {
    // On any network/parse error, cache null and move on
    console.error(`ABI fetch failed for ${address}:`, err.message);
    abiCache.set(key, null);
    return null;
  }
};
