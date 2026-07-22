import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAbi, getTrace, getAddressType, retryPolicy, EtherscanError, RateLimitError } from './etherscanService.js';

const fetchMock = vi.fn();
global.fetch = fetchMock;

// Shared across every suite in this file: a clean mock and a configured API key.
beforeEach(() => {
    vi.clearAllMocks();
    process.env.ETHERSCAN_API_KEY = 'test-key';
});

afterEach(() => {
    delete process.env.ETHERSCAN_API_KEY;
});

const TO = '0x1111111111111111111111111111111111111111';

describe('etherscanService — ABI caching', () => {
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

describe('etherscanService — getTrace replay params', () => {
    const FROM = '0x9145da2c4a2d3dea910006a7861d29e219fd2d58';
    const ok = () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' }) });
    const calledUrl = () => fetchMock.mock.calls[0][0];

    it('builds the exact legacy URL when from/gas are not passed', async () => {
        fetchMock.mockResolvedValueOnce(ok());
        await getTrace({ to: TO, data: '0xabc123', blockNumber: '18500000' });
        expect(calledUrl()).toBe(
            `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_call&to=${TO}&data=0xabc123&tag=0x11a49a0&apikey=test-key`
        );
    });

    it('appends &from= when a sender is passed', async () => {
        fetchMock.mockResolvedValueOnce(ok());
        await getTrace({ to: TO, data: '0xabc123', blockNumber: '18500000', from: FROM });
        expect(calledUrl()).toBe(
            `https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_call&to=${TO}&data=0xabc123&tag=0x11a49a0&from=${FROM}&apikey=test-key`
        );
    });

    it('hex-encodes decimal gas the same way blockNumber is encoded', async () => {
        fetchMock.mockResolvedValueOnce(ok());
        await getTrace({ to: TO, data: '0xabc123', blockNumber: '18500000', from: FROM, gas: '100000' });
        expect(calledUrl()).toContain('&gas=0x186a0&');
    });

    it('passes 0x-hex gas through unchanged', async () => {
        fetchMock.mockResolvedValueOnce(ok());
        await getTrace({ to: TO, data: '0xabc123', blockNumber: '0x1', from: FROM, gas: '0x186a0' });
        expect(calledUrl()).toContain('&gas=0x186a0&');
    });
});

describe('etherscanService — rate-limit retry', () => {
    const rateLimited = { ok: true, status: 200, json: async () => ({ status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (5/sec)' }) };
    const ok = { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' }) };
    const args = { to: '0x' + '1'.repeat(40), data: '0x', blockNumber: '0x1' };

    afterEach(() => { retryPolicy.retries = 0; });

    it('retries a throttled request and succeeds', async () => {
        retryPolicy.retries = 3;
        retryPolicy.baseDelayMs = 5;
        fetchMock.mockResolvedValueOnce(rateLimited).mockResolvedValueOnce(ok);

        await expect(getTrace(args)).resolves.toEqual({ jsonrpc: '2.0', id: 1, result: '0x' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up after the configured number of retries', async () => {
        retryPolicy.retries = 2;
        retryPolicy.baseDelayMs = 5;
        fetchMock.mockResolvedValue(rateLimited);

        await expect(getTrace(args)).rejects.toThrow(RateLimitError);
        expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('does not retry a non-rate-limit error', async () => {
        retryPolicy.retries = 3;
        fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

        await expect(getTrace(args)).rejects.toThrow(EtherscanError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});


describe('etherscanService — getAddressType', () => {
    const rpc = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });

    it('classifies an address with no code as a wallet', async () => {
        fetchMock.mockResolvedValueOnce(rpc('0x'));
        expect(await getAddressType('0x' + 'b'.repeat(40))).toBe('wallet');
    });

    it('classifies an address with bytecode as a contract', async () => {
        fetchMock.mockResolvedValueOnce(rpc('0x60806040523480156100'));
        expect(await getAddressType('0x' + 'c'.repeat(40))).toBe('contract');
    });

    // Regression: since EIP-7702 (Pectra) an EOA can carry a delegation
    // designator, so eth_getCode returns code for an account that is still a
    // wallet. Observed live on vitalik.eth, which returned
    // 0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d and was misread as a
    // contract — flipping the analysis to inbound calls for a real wallet.
    it('classifies an EIP-7702 delegated EOA as a wallet, not a contract', async () => {
        fetchMock.mockResolvedValueOnce(rpc('0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d'));
        expect(await getAddressType('0x' + 'f'.repeat(40))).toBe('wallet');
    });

    it('caches a contract result — no second fetch', async () => {
        const addr = '0x' + 'd'.repeat(40);
        fetchMock.mockResolvedValueOnce(rpc('0x6080604052'));
        expect(await getAddressType(addr)).toBe('contract');
        expect(await getAddressType(addr)).toBe('contract');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not cache a thrown error — a later call retries', async () => {
        const addr = '0x' + 'e'.repeat(40);
        fetchMock.mockRejectedValueOnce(new TypeError('network down'));
        await expect(getAddressType(addr)).rejects.toThrow(EtherscanError);
        fetchMock.mockResolvedValueOnce(rpc('0x'));
        expect(await getAddressType(addr)).toBe('wallet');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('etherscanService — rate-limit detection', () => {
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
        const result = await getTrace({ to: TO, data: '0x', blockNumber: '0x1' });
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

        await expect(getTrace({ to: TO, data: '0x', blockNumber: '0x1' })).rejects.toThrow(RateLimitError);
    });
});
