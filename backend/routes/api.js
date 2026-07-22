import express from 'express';
import { validateAddress, validateTrace, validateHash } from '../middleware/validator.js';
import {
  getTransactions,
  getTrace,
  getAbi,
  getTransactionReceipt,
  getTransactionByHash,
  getAddressType,
  ConfigError,
  RateLimitError,
} from '../services/etherscanService.js';
import { buildErrorSelectorMap, decodeRevertData } from '../utils/abiDecoder.js';

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

/**
 * GET /api/address-type/:address
 * Classifies the address so the frontend knows which failures are meaningful:
 * a wallet's own sent transactions, or the calls made to a contract.
 * Response: { type: 'wallet' | 'contract' }
 */
router.get('/address-type/:address', validateAddress, async (req, res) => {
  try {
    res.json({ type: await getAddressType(req.params.address) });
  } catch (error) {
    handleServiceError(error, res, 'address-type');
  }
});

/**
 * POST /api/trace
 * Replays the call and returns the DECODED revert reason. Decoding happens here
 * (ethers) rather than in the browser so there is exactly one decoder — it
 * handles ints, arrays and tuples correctly, which a hand-rolled one did not.
 * Response: { revert: {…}|null, verified: bool, outcome: 'reverted'|'succeeded' }
 *
 * `outcome` matters: a null revert is ambiguous on its own. 'reverted' with a
 * null revert means the call really did revert without decodable data (a
 * genuine bare revert), whereas 'succeeded' means the replay did NOT reproduce
 * the failure at all — we learned nothing, and the caller must not claim it
 * reverted silently.
 */
// Resolve a contract's error selectors, degrading to an empty map. An ABI
// failure must never sink the trace: Error(string) and Panic() decode without
// one, and an unknown selector still yields raw output.
async function resolveErrorSelectors(address) {
  try {
    const abi = await getAbi(address);
    return { verified: Boolean(abi), selectors: buildErrorSelectorMap(abi || []) };
  } catch (err) {
    console.warn('[trace] ABI unavailable, decoding without it:', err.message);
    return { verified: false, selectors: new Map() };
  }
}

router.post('/trace', validateTrace, async (req, res) => {
  try {
    // validateTrace has already checked/normalized the body; getTrace picks the
    // fields it needs, so there's nothing to flatten and reassemble here.
    const result = await getTrace(req.body);
    const outcome = result?.error ? 'reverted' : 'succeeded';
    const data = result?.error?.data;

    // Only fetch the ABI when there is revert data for it to decode. With no
    // data the selector map is unused and `verified` is never rendered, so the
    // fetch would be a wasted queue slot — and on the wallet path every
    // transaction has a different callee, so those misses are not amortized.
    const { verified, selectors } = data
      ? await resolveErrorSelectors(req.body.to)
      : { verified: false, selectors: new Map() };

    res.json({ revert: data ? decodeRevertData(data, selectors) : null, verified, outcome });
  } catch (error) {
    handleServiceError(error, res, 'trace');
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