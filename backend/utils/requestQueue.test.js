import { describe, it, expect } from 'vitest';
import { RequestQueue } from './requestQueue.js';
import { RateLimitError, EtherscanError } from './errors.js';

describe('RequestQueue throttling', () => {
    // Regression: the delay used to be applied only when another task was
    // already waiting. Real callers are sequential (the frontend awaits each
    // trace), so each arrived to an empty queue, took the no-delay path, and the
    // throttle never engaged — we ran as fast as the network allowed and
    // Etherscan replied 429. Spacing is now measured from when the previous
    // request STARTED, so it holds for sequential callers too.
    it('spaces sequential enqueues that each arrive to an empty queue', async () => {
        const q = new RequestQueue(60);
        const at = [];
        const stamp = () => { at.push(Date.now()); return 'ok'; };

        // Await each before enqueuing the next — the queue is empty every time.
        await q.enqueue(stamp);
        await q.enqueue(stamp);
        await q.enqueue(stamp);

        expect(at).toHaveLength(3);
        expect(at[1] - at[0]).toBeGreaterThanOrEqual(50);
        expect(at[2] - at[1]).toBeGreaterThanOrEqual(50);
    });

    it('still spaces a burst enqueued all at once', async () => {
        const q = new RequestQueue(60);
        const at = [];
        const stamp = () => { at.push(Date.now()); return 'ok'; };

        await Promise.all([q.enqueue(stamp), q.enqueue(stamp), q.enqueue(stamp)]);

        expect(at[1] - at[0]).toBeGreaterThanOrEqual(50);
        expect(at[2] - at[1]).toBeGreaterThanOrEqual(50);
    });

    // Regression: the wait is computed from a stored timestamp, so a clock that
    // jumps backwards (NTP correction, or a suite faking timers) makes the
    // elapsed time negative. Unclamped, delayMs - sinceLast then sleeps for the
    // whole length of the jump and the queue never drains again.
    it('never waits longer than one interval when the clock jumps backwards', async () => {
        const q = new RequestQueue(60);
        await q.enqueue(() => 'first');
        q.lastRunAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days ahead

        const start = Date.now();
        await q.enqueue(() => 'second');
        expect(Date.now() - start).toBeLessThan(500);
    });

    it('does not delay the very first request', async () => {
        const q = new RequestQueue(500);
        const start = Date.now();
        await q.enqueue(() => 'ok');
        expect(Date.now() - start).toBeLessThan(200);
    });

    it('rejects with RateLimitError once the queue is full (backpressure)', async () => {
        const q = new RequestQueue(0, { maxQueue: 2 });
        const slow = () => new Promise(r => setTimeout(() => r('ok'), 50));

        const inflight = [q.enqueue(slow), q.enqueue(slow), q.enqueue(slow)];
        await expect(q.enqueue(slow)).rejects.toThrow(RateLimitError);
        await Promise.allSettled(inflight);
    });

    it('drops a task that waited past maxWaitMs instead of starting it', async () => {
        const q = new RequestQueue(0, { maxWaitMs: 10 });
        let ran = false;
        // The first task occupies the queue long enough that the second exceeds
        // its deadline while still waiting, so it is dropped rather than started.
        const first = q.enqueue(() => new Promise(r => setTimeout(r, 60)));
        const second = q.enqueue(() => { ran = true; });

        await expect(second).rejects.toThrow(EtherscanError);
        await first;
        expect(ran).toBe(false);
    });
});
