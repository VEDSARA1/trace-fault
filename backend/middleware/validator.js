export const validateAddress = (req, res, next) => {
  const { address } = req.params;
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Invalid Ethereum contract address.' });
  }
  next();
};

export const validateTrace = (req, res, next) => {
  const { to, data, blockNumber } = req.body;
  if (!to || !/^0x[a-fA-F0-9]{40}$/.test(to)) {
    return res.status(400).json({ error: 'Invalid "to" address.' });
  }
  if (!data || !/^0x[a-fA-F0-9]*$/.test(data)) {
    return res.status(400).json({ error: 'Invalid "data" hex string.' });
  }
  if (!blockNumber || !/^(0x[a-fA-F0-9]+|\d+)$/.test(blockNumber)) {
    return res.status(400).json({ error: 'Invalid "blockNumber".' });
  }
  next();
};
