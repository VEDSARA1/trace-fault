import express from 'express';
import { validateAddress, validateTrace } from '../middleware/validator.js';
import {
  getTransactions,
  getTrace,
  getAbi,
  ConfigError,
  RateLimitError,
  EtherscanError,
} from '../services/etherscanService.js';
import { buildErrorSelectorMap } from '../utils/abiDecoder.js';

const router = express.Router();

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
    const { to, data, blockNumber } = req.body;
    const result = await getTrace(to, data, blockNumber);
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

export default router;
