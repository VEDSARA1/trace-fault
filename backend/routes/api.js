import express from 'express';
import { validateAddress, validateTrace } from '../middleware/validator.js';
import { getTransactions, getTrace, getAbi } from '../services/etherscanService.js';
import { buildErrorSelectorMap } from '../utils/abiDecoder.js';

const router = express.Router();

router.get('/transactions/:address', validateAddress, async (req, res, next) => {
  try {
    const data = await getTransactions(req.params.address);
    res.json(data);
  } catch (error) {
    console.error('Error fetching transactions:', error.message);
    res.status(502).json({ error: 'Failed to communicate with Etherscan API.' });
  }
});

router.post('/trace', validateTrace, async (req, res, next) => {
  try {
    const { to, data, blockNumber } = req.body;
    const result = await getTrace(to, data, blockNumber);
    res.json(result);
  } catch (error) {
    console.error('Error fetching trace:', error.message);
    res.status(502).json({ error: 'Failed to communicate with Etherscan API.' });
  }
});

/**
 * GET /api/abi/:address
 * Returns the verified error selector map for the contract, plus a verified flag.
 * If the contract is unverified, returns an empty map and verified: false.
 */
router.get('/abi/:address', validateAddress, async (req, res) => {
  try {
    const abi = await getAbi(req.params.address);
    if (!abi) {
      return res.json({ verified: false, selectors: {} });
    }
    const selectorMap = buildErrorSelectorMap(abi);
    // Convert Map to plain object for JSON serialisation
    const selectors = {};
    for (const [sel, frag] of selectorMap.entries()) {
      selectors[sel] = frag;
    }
    res.json({ verified: true, selectors });
  } catch (error) {
    console.error('Error fetching ABI:', error.message);
    // Never let ABI errors block the caller
    res.json({ verified: false, selectors: {} });
  }
});

export default router;
