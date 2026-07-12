import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock the service layer so route tests don't depend on real network calls —
// we're testing "does this route map each error type to the right status",
// not "does Etherscan actually respond correctly".
vi.mock('../services/etherscanService.js', async () => {
    const actual = await vi.importActual('../services/etherscanService.js');
    return {
        ...actual,
        getTransactions: vi.fn(),
        getTrace: vi.fn(),
        getAbi: vi.fn(),
    };
});

const { getTransactions, ConfigError, RateLimitError, EtherscanError } =
    await import('../services/etherscanService.js');
const apiRouter = (await import('./api.js')).default;

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    return app;
}

const VALID_ADDRESS = '0x1111111254fb6c44bac0bed2854e76f90643097d';

describe('error-status mapping in routes/api.js', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('maps ConfigError to HTTP 500 with a generic message (no internal details leaked)', async () => {
        getTransactions.mockRejectedValueOnce(new ConfigError('ETHERSCAN_API_KEY is not configured'));

        const res = await request(buildApp()).get(`/api/transactions/${VALID_ADDRESS}`);

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Internal server error.');
        // Make sure the real (sensitive) message never reaches the client.
        expect(JSON.stringify(res.body)).not.toContain('ETHERSCAN_API_KEY');
    });

    it('maps RateLimitError to HTTP 429', async () => {
        getTransactions.mockRejectedValueOnce(new RateLimitError('Etherscan rate limit reached'));

        const res = await request(buildApp()).get(`/api/transactions/${VALID_ADDRESS}`);

        expect(res.status).toBe(429);
        expect(res.body.error).toMatch(/rate limit/i);
    });

    it('maps EtherscanError to HTTP 502', async () => {
        getTransactions.mockRejectedValueOnce(new EtherscanError('Etherscan HTTP error, status 500'));

        const res = await request(buildApp()).get(`/api/transactions/${VALID_ADDRESS}`);

        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/Etherscan/i);
    });
});