const ADDRESS_RX = /^0x[a-fA-F0-9]{40}$/;
const HASH_RX = /^0x[a-fA-F0-9]{64}$/;
const QUANTITY_RX = /^(0x[a-fA-F0-9]+|\d+)$/;

const isAddress = (v) => typeof v === 'string' && ADDRESS_RX.test(v);
const isHash = (v) => typeof v === 'string' && HASH_RX.test(v);

// A decimal-or-0x-hex quantity. Returns the value normalized to a string, or
// null when invalid — callers normalize into req.body so downstream services
// always receive a string (prevents TypeErrors on numeric input).
const asQuantity = (v) =>
  (typeof v === 'string' || typeof v === 'number') && QUANTITY_RX.test(String(v)) ? String(v) : null;

export const validateAddress = (req, res, next) => {
  if (!isAddress(req.params.address)) {
    return res.status(400).json({ error: 'Invalid Ethereum contract address.' });
  }
  next();
};

export const validateHash = (req, res, next) => {
  if (!isHash(req.params.hash)) {
    return res.status(400).json({ error: 'Invalid transaction hash.' });
  }
  next();
};

export const validateTrace = (req, res, next) => {
  const { to, data, blockNumber, from, gas } = req.body || {};
  if (!isAddress(to)) {
    return res.status(400).json({ error: 'Invalid "to" address.' });
  }
  if (typeof data !== 'string' || !/^0x[a-fA-F0-9]*$/.test(data)) {
    return res.status(400).json({ error: 'Invalid "data" hex string.' });
  }
  const blockNumberStr = asQuantity(blockNumber);
  if (blockNumberStr === null) {
    return res.status(400).json({ error: 'Invalid "blockNumber".' });
  }
  req.body.blockNumber = blockNumberStr;

  // Optional replay-fidelity fields: absent is fine; present-but-malformed is a 400.
  if (from != null && !isAddress(from)) {
    return res.status(400).json({ error: 'Invalid "from" address.' });
  }
  if (gas != null) {
    const gasStr = asQuantity(gas);
    if (gasStr === null) {
      return res.status(400).json({ error: 'Invalid "gas" quantity.' });
    }
    req.body.gas = gasStr;
  }
  next();
};
