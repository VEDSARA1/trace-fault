import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAbi, getTrace, EtherscanError, RateLimitError } from './etherscanService.js';

const fetchMock = vi.fn();
global.fetch = fetchMock;

describe('etherscanService — ABI caching', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.ETHERSCAN_API_KEY = 'test-key';
    });

    afterEach(() => {
        delete process.env.ETHERSCAN_API_KEY;
    });

    // Regression test for a real bug: getAbi used to cache `null` any time the
    // fetch threw, including transient failures like a network blip — meaning a
    // single bad moment would permanently mark a perfectly good contract as
    // "unverified" for the rest of the server's uptime. The fix only caches
    // CONFIRMED outcomes (a real "unverified" response, or a real parsed ABI),
    // and never caches a thrown error, so a later call retries instead of
    // reusing the earlier failure.
    it('does NOT cache a thrown error — a later call retries instead of reusing the failure', async () => {
        const ADDRESS = '0x2222222222222222222222222222222222222b';

        // First call: simulate a transient network failure.
        fetchMock.mockRejectedValueOnce(new TypeError('network down'));
        await expect(getAbi(ADDRESS)).rejects.toThrow(EtherscanError);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Second call: network is back, returns a real, verified ABI.
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ status: '1', result: '[{"type":"function","name":"foo"}]' }),
        });
        const result = await getAbi(ADDRESS);

        // The key assertion: fetch was hit AGAIN on the second call — the
        // earlier failure was never cached, so this address wasn't poisoned.
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result).toEqual([{ type: 'function', name: 'foo' }]);
    });

    const okAbi = (result) => ({ ok: true, status: 200, json: async () => ({ status: '1', result }) });
    const unverified = () => ({ ok: true, status: 200, json: async () => ({ status: '0', message: 'NOTOK', result: 'Contract source code not verified' }) });

    it('caches a verified ABI forever — no re-fetch even far in the future', async () => {
        vi.useFakeTimers();
        try {
            const ADDRESS = '0x3333333333333333333333333333333333333333';
            fetchMock.mockResolvedValueOnce(okAbi('[{"type":"function","name":"foo"}]'));

            const first = await getAbi(ADDRESS);
            expect(first).toEqual([{ type: 'function', name: 'foo' }]);
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // Jump 30 days ahead — a verified ABI must still be served from cache.
            vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000);
            const second = await getAbi(ADDRESS);
            expect(second).toEqual([{ type: 'function', name: 'foo' }]);
            expect(fetchMock).toHaveBeenCalledTimes(1); // still 1 — no re-fetch
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-fetches an unverified entry only after the 24h TTL lapses', async () => {
        vi.useFakeTimers();
        try {
            const ADDRESS = '0x4444444444444444444444444444444444444444';
            fetchMock.mockResolvedValueOnce(unverified());

            expect(await getAbi(ADDRESS)).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // Within the TTL: served from cache, no new fetch.
            vi.advanceTimersByTime(23 * 60 * 60 * 1000);
            expect(await getAbi(ADDRESS)).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // Past the TTL: the entry is stale, so we re-check — and this time
            // the contract has since been verified.
            vi.advanceTimersByTime(2 * 60 * 60 * 1000); // now 25h total
            fetchMock.mockResolvedValueOnce(okAbi('[{"type":"error","name":"Bad"}]'));
            expect(await getAbi(ADDRESS)).toEqual([{ type: 'error', name: 'Bad' }]);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('etherscanService — rate-limit detection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.ETHERSCAN_API_KEY = 'test-key';
    });

    afterEach(() => {
        delete process.env.ETHERSCAN_API_KEY;
    });

    const TO = '0x1111111111111111111111111111111111111111';

    // Regression test: an eth_call whose revert message happens to contain
    // "rate limit" is the CONTRACT's own error, not Etherscan throttling us.
    // It must NOT be misread as a RateLimitError (which the route maps to 429).
    it('does NOT flag a contract revert message containing "rate limit" as rate limiting', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                jsonrpc: '2.0',
                id: 1,
                error: { code: 3, message: 'execution reverted: rate limit exceeded', data: '0x' },
            }),
        });

        // Resolves normally — the JSON-RPC error is returned to the caller, not thrown.
        const result = await getTrace(TO, '0x', '0x1');
        expect(result.error.message).toContain('rate limit');
    });

    // Etherscan's real throttle signal: an error-shaped (status "0") body whose
    // result carries the rate-limit text. This one SHOULD throw RateLimitError.
    it('flags Etherscan\'s status-0 NOTOK rate-limit body as a RateLimitError', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                status: '0',
                message: 'NOTOK',
                result: 'Max calls per sec rate limit reached (5/sec)',
            }),
        });

        await expect(getTrace(TO, '0x', '0x1')).rejects.toThrow(RateLimitError);
    });
});
