import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAbi, EtherscanError } from './etherscanService.js';

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
});
