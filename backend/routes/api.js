import express from 'express';
import { validateAddress, validateTrace, validateHash } from '../middleware/validator.js';
import {
  getTransactions,
  getTrace,
  getAbi,
  getTransactionReceipt,
  getTransactionByHash,
  ConfigError,
  RateLimitError,
} from '../services/etherscanService.js';
import { buildErrorSelectorMap } from '../utils/abiDecoder.js';

const router = express.Router();

// Safely parse a 0x-hex quantity into a BigInt; returns null on missing/bad input.
function hexToBigInt(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    return BigInt(hex);
  } catch {
    return null;
  }
}

function handleServiceError(error, res, contextLabel) {
  if (error instanceof ConfigError) {
    console.error(`[${contextLabel}] config error:`, error.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
  if (error instanceof RateLimitError) {
    console.warn(`[${contextLabel}] rate limit:`, error.message);
    return res.status(429).json({ error: 'Etherscan rate limit reached. Please slow down and retry shortly.' });
  }
  // EtherscanError or anything unexpected → treat as bad-gateway
  console.error(`[${contextLabel}] upstream error:`, error.message);
  return res.status(502).json({ error: 'Failed to communicate with Etherscan API.' });
}

router.get('/transactions/:address', validateAddress, async (req, res) => {
  try {
    const data = await getTransactions(req.params.address);
    res.json(data);
  } catch (error) {
    handleServiceError(error, res, 'transactions');
  }
});

router.post('/trace', validateTrace, async (req, res) => {
  try {
    const { to, data, blockNumber, from, gas } = req.body;
    const result = await getTrace(to, data, blockNumber, from, gas);
    res.json(result);
  } catch (error) {
    handleServiceError(error, res, 'trace');
  }
});

/**
 * GET /api/abi/:address
 * Returns the verified error selector map for the contract, plus a verified flag.
 * If the contract is confirmed unverified, returns an empty map and verified: false.
 * Real failures (config / rate-limit / upstream) return the appropriate error status.
 */
router.get('/abi/:address', validateAddress, async (req, res) => {
  try {
    const abi = await getAbi(req.params.address);
    if (!abi) {
      return res.json({ verified: false, selectors: {} });
    }
    const selectorMap = buildErrorSelectorMap(abi);
    const selectors = {};
    for (const [sel, frag] of selectorMap.entries()) {
      selectors[sel] = frag;
    }
    res.json({ verified: true, selectors });
  } catch (error) {
    handleServiceError(error, res, 'abi');
  }
});

/**
 * GET /api/enrich/:hash
 * Lazy per-transaction enrichment, fetched only when a card is expanded.
 * Combines eth_getTransactionReceipt + eth_getTransactionByHash into one call
 * and returns normalized fields (numbers as decimal strings to preserve wei).
 */
router.get('/enrich/:hash', validateHash, async (req, res) => {
  try {
    const { hash } = req.params;
    const [receiptEnv, txEnv] = await Promise.all([
      getTransactionReceipt(hash),
      getTransactionByHash(hash),
    ]);

    const receipt = receiptEnv?.result || null;
    const tx = txEnv?.result || null;
    if (!receipt && !tx) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    // gas burned = gasUsed * effectiveGasPrice. effectiveGasPrice lives on the
    // receipt (post-London); fall back to the tx's gasPrice for legacy/old txs.
    const gasUsed = hexToBigInt(receipt?.gasUsed);
    const gasPrice = hexToBigInt(receipt?.effectiveGasPrice) ?? hexToBigInt(tx?.gasPrice);
    const gasBurnedWei = gasUsed !== null && gasPrice !== null ? (gasUsed * gasPrice).toString() : null;

    const valueWei = hexToBigInt(tx?.value);
    const nonce = hexToBigInt(tx?.nonce);
    const txType = hexToBigInt(tx?.type);

    res.json({
      status: receipt?.status ?? null,              // '0x1' success, '0x0' failed
      gasUsed: gasUsed !== null ? gasUsed.toString() : null,
      effectiveGasPriceWei: gasPrice !== null ? gasPrice.toString() : null,
      gasBurnedWei,
      valueWei: valueWei !== null ? valueWei.toString() : null,
      nonce: nonce !== null ? Number(nonce) : null,
      txType: txType !== null ? Number(txType) : null,
    });
  } catch (error) {
    handleServiceError(error, res, 'enrich');
  }
});

export default router;