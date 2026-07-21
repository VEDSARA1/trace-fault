import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock the service layer so route tests are network-free — we're testing the
// route's own logic (gas-burned math, field normalization, status codes), not
// Etherscan. Error classes come through from the real module.
vi.mock('../services/etherscanService.js', async () => {
  const actual = await vi.importActual('../services/etherscanService.js');
  return {
    ...actual,
    getTransactions: vi.fn(),
    getTrace: vi.fn(),
    getAbi: vi.fn(),
    getTransactionReceipt: vi.fn(),
    getTransactionByHash: vi.fn(),
    getAddressType: vi.fn(),
  };
});

const { getTransactionReceipt, getTransactionByHash, getAddressType, getTrace, getAbi, RateLimitError } =
  await import('../services/etherscanService.js');
const apiRouter = (await import('./api.js')).default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  return app;
}

const HASH = '0x' + '1'.repeat(64);

// JSON-RPC envelope helper — the proxy module wraps results in { result }.
const env = (result) => ({ jsonrpc: '2.0', id: 1, result });

describe('GET /api/enrich/:hash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an invalid hash with 400', async () => {
    const res = await request(makeApp()).get('/api/enrich/0xnothex');
    expect(res.status).toBe(400);
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('computes gas burned from receipt gasUsed * effectiveGasPrice', async () => {
    // 21000 gas * 1 gwei = 21_000_000_000_000 wei
    getTransactionReceipt.mockResolvedValue(env({
      status: '0x0',
      gasUsed: '0x5208',            // 21000
      effectiveGasPrice: '0x3b9aca00', // 1e9
    }));
    getTransactionByHash.mockResolvedValue(env({
      value: '0xde0b6b3a7640000', // 1e18 = 1 ETH
      nonce: '0x5',
      type: '0x2',
      gasPrice: '0x77359400',      // 2 gwei — should be IGNORED (effectiveGasPrice present)
    }));

    const res = await request(makeApp()).get(`/api/enrich/${HASH}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: '0x0',
      gasUsed: '21000',
      effectiveGasPriceWei: '1000000000',
      gasBurnedWei: '21000000000000',
      valueWei: '1000000000000000000',
      nonce: 5,
      txType: 2,
    });
  });

  it('falls back to the tx gasPrice when the receipt has no effectiveGasPrice', async () => {
    // Legacy tx: receipt omits effectiveGasPrice, so gasPrice (2 gwei) is used.
    getTransactionReceipt.mockResolvedValue(env({
      status: '0x0',
      gasUsed: '0x5208',       // 21000
    }));
    getTransactionByHash.mockResolvedValue(env({
      value: '0x0',
      nonce: '0x1',
      type: '0x0',
      gasPrice: '0x77359400',  // 2e9
    }));

    const res = await request(makeApp()).get(`/api/enrich/${HASH}`);

    expect(res.status).toBe(200);
    expect(res.body.effectiveGasPriceWei).toBe('2000000000');
    expect(res.body.gasBurnedWei).toBe('42000000000000'); // 21000 * 2e9
    expect(res.body.txType).toBe(0);
  });

  it('returns 404 when neither receipt nor tx is found', async () => {
    getTransactionReceipt.mockResolvedValue(env(null));
    getTransactionByHash.mockResolvedValue(env(null));

    const res = await request(makeApp()).get(`/api/enrich/${HASH}`);
    expect(res.status).toBe(404);
  });

  it('maps a RateLimitError from the service to 429', async () => {
    getTransactionReceipt.mockRejectedValue(new RateLimitError('slow down'));
    getTransactionByHash.mockRejectedValue(new RateLimitError('slow down'));

    const res = await request(makeApp()).get(`/api/enrich/${HASH}`);
    expect(res.status).toBe(429);
  });
});

// A null `revert` is ambiguous by itself, so the route reports how the replay
// ended. Without this the frontend cannot tell a genuine bare revert from a
// replay that never reproduced the failure, and would wrongly claim the former.
describe('POST /api/trace — replay outcome', () => {
  const body = {
    to: '0x' + 'a'.repeat(40),
    data: '0x',
    blockNumber: '18500000',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getAbi.mockResolvedValue(null);
  });

  it("reports outcome 'reverted' when the replay reverted with data", async () => {
    getTrace.mockResolvedValue({ error: { code: 3, message: 'execution reverted', data: '0x5bf6f916' } });
    const res = await request(makeApp()).post('/api/trace').send(body);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('reverted');
    expect(res.body.revert).not.toBeNull();
  });

  it("reports outcome 'reverted' with a null revert for a genuine bare revert", async () => {
    getTrace.mockResolvedValue({ error: { code: 3, message: 'execution reverted' } });
    const res = await request(makeApp()).post('/api/trace').send(body);
    expect(res.body.outcome).toBe('reverted');
    expect(res.body.revert).toBeNull();
  });

  it("reports outcome 'succeeded' when the replay did not reproduce the failure", async () => {
    getTrace.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: '0x000000000000000000000000000000000000000000000000000000004a54fdf6' });
    const res = await request(makeApp()).post('/api/trace').send(body);
    expect(res.body.outcome).toBe('succeeded');
    expect(res.body.revert).toBeNull();
  });
});

describe('GET /api/address-type/:address', () => {
  const ADDRESS = '0x' + 'a'.repeat(40);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an invalid address with 400', async () => {
    const res = await request(makeApp()).get('/api/address-type/0xnothex');
    expect(res.status).toBe(400);
    expect(getAddressType).not.toHaveBeenCalled();
  });

  it('reports a wallet', async () => {
    getAddressType.mockResolvedValue('wallet');
    const res = await request(makeApp()).get(`/api/address-type/${ADDRESS}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: 'wallet' });
  });

  it('reports a contract', async () => {
    getAddressType.mockResolvedValue('contract');
    const res = await request(makeApp()).get(`/api/address-type/${ADDRESS}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: 'contract' });
  });

  it('maps a RateLimitError to 429', async () => {
    getAddressType.mockRejectedValue(new RateLimitError('slow down'));
    const res = await request(makeApp()).get(`/api/address-type/${ADDRESS}`);
    expect(res.status).toBe(429);
  });
});
