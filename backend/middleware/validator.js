export const validateAddress = (req, res, next) => {
  const { address } = req.params;
  if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid Ethereum contract address.' });
  }
  next();
};

export const validateHash = (req, res, next) => {
  const { hash } = req.params;
  if (typeof hash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(hash)) {
    return res.status(400).json({ error: 'Invalid transaction hash.' });
  }
  next();
};

export const validateTrace = (req, res, next) => {
  const { to, data, blockNumber } = req.body || {};
  if (typeof to !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(to)) {
    return res.status(400).json({ error: 'Invalid "to" address.' });
  }
  if (typeof data !== 'string' || !/^0x[a-fA-F0-9]*$/.test(data)) {
    return res.status(400).json({ error: 'Invalid "data" hex string.' });
  }
  const blockNumberStr = String(blockNumber);
  if ((typeof blockNumber !== 'string' && typeof blockNumber !== 'number') || !/^(0x[a-fA-F0-9]+|\d+)$/.test(blockNumberStr)) {
    return res.status(400).json({ error: 'Invalid "blockNumber".' });
  }
  // Normalize blockNumber to string to prevent TypeError in downstream services
  req.body.blockNumber = blockNumberStr;

  // Optional replay-fidelity fields: absent is fine; present-but-malformed is a 400.
  const { from, gas } = req.body;
  if (from !== undefined && from !== null) {
    if (typeof from !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(from)) {
      return res.status(400).json({ error: 'Invalid "from" address (optional, but must be a valid address when present).' });
    }
  }
  if (gas !== undefined && gas !== null) {
    const gasStr = String(gas);
    if ((typeof gas !== 'string' && typeof gas !== 'number') || !/^(0x[a-fA-F0-9]+|\d+)$/.test(gasStr)) {
      return res.status(400).json({ error: 'Invalid "gas" (optional, but must be a decimal or 0x-hex quantity when present).' });
    }
    req.body.gas = gasStr;
  }
  next();
};
