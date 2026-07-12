import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTransactions, getTrace, getAbi, ConfigError, RateLimitError, EtherscanError } from './etherscanService.js';

// Mock node-fetch
const fetchMock = vi.fn();
global.fetch = fetchMock;

describe('etherscanService', () => {
    const VALID_ADDRESS = '0x1111111254fb6c44bac0bed2854e76f90643097d';

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.ETHERSCAN_API_KEY = 'test-key';
    });

    afterEach(() => {
        delete process.env.ETHERSCAN_API_KEY;
    });

    it('throws ConfigError if API key is missing', async () => {
        delete process.env.ETHERSCAN_API_KEY;
        await expect(getTransactions(VALID_ADDRESS)).rejects.toThrow(ConfigError);
    });

    it('fetches transactions successfully', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ status: '1', message: 'OK', result: [{ hash: '0x123' }] })
        });

        const data = await getTransactions(VALID_ADDRESS);
        expect(data.result).toHaveLength(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws RateLimitError on HTTP 429', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 429,
        });
        await expect(getTransactions(VALID_ADDRESS)).rejects.toThrow(RateLimitError);
    });

    it('throws RateLimitError if Etherscan body implies rate limit', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' })
        });
        await expect(getTransactions(VALID_ADDRESS)).rejects.toThrow(RateLimitError);
    });

    it('handles timeout (AbortError)', async () => {
        const abortErr = new Error('AbortError');
        abortErr.name = 'AbortError';
        fetchMock.mockRejectedValueOnce(abortErr);
        await expect(getTransactions(VALID_ADDRESS)).rejects.toThrow(/timed out/i);
    });

    it('formats blockNumber properly in getTrace', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ status: '1', result: '0xabc' })
        });

        await getTrace(VALID_ADDRESS, '0x00', 10);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const url = fetchMock.mock.calls[0][0];
        expect(url).toContain('tag=0xa'); // 10 -> 0xa
    });

    it('caches getAbi results and prevents concurrent fetches', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ status: '1', result: '[{"type":"error","name":"Test"}]' })
        });

        // Trigger two concurrent requests for the same ABI
        const p1 = getAbi(VALID_ADDRESS);
        const p2 = getAbi(VALID_ADDRESS);
        
        const [r1, r2] = await Promise.all([p1, p2]);

        expect(r1).toEqual([{ type: 'error', name: 'Test' }]);
        expect(r1).toStrictEqual(r2);
        
        // Ensure fetch was only called ONCE despite two requests
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
