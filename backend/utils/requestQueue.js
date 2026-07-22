/**
 * A serial request queue that spaces successive tasks by a fixed delay.
 *
 * Lives here rather than inside a service so it is a real unit with its own
 * tests, reusable by any client that has to respect a per-second API budget.
 */
import { RateLimitError, EtherscanError } from './errors.js';

export class RequestQueue {
  /**
   * @param {number} delayMs   Spacing enforced between successive requests.
   * @param {object} [opts]
   * @param {number} [opts.maxQueue]   Max tasks allowed to wait; beyond this, enqueue is rejected (backpressure).
   * @param {number} [opts.maxWaitMs]  Max time a task may sit queued before it starts; exceeded → rejected.
   */
  constructor(delayMs, { maxQueue = 50, maxWaitMs = 15000 } = {}) {
    this.delayMs = delayMs;
    this.maxQueue = maxQueue;
    this.maxWaitMs = maxWaitMs;
    this.queue = [];
    this.isProcessing = false;
    // When the last request actually STARTED. Spacing is measured from this, not
    // from queue occupancy — see processQueue.
    this.lastRunAt = 0;
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      // Backpressure: don't let the queue grow without bound. A caller that
      // arrives when we're already saturated fails fast with a rate-limit
      // signal rather than waiting an unbounded amount of time.
      if (this.queue.length >= this.maxQueue) {
        reject(new RateLimitError('Server is busy (request queue full). Please retry shortly.'));
        return;
      }
      this.queue.push({ task, resolve, reject, enqueuedAt: Date.now() });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const { task, resolve, reject, enqueuedAt } = this.queue.shift();

      // The per-request fetch timeout only starts once a task RUNS. A task that
      // waited too long in line would otherwise hang the client far past that
      // timeout, so drop it here instead of starting a now-stale request.
      if (Date.now() - enqueuedAt > this.maxWaitMs) {
        reject(new EtherscanError('Timed out waiting in the request queue.'));
        continue;
      }

      // Space from when the last request STARTED, not merely between items that
      // happen to be queued together. Callers here are sequential (the frontend
      // awaits each trace), so each arrives to an empty queue — gating the delay
      // on queue occupancy meant the throttle never engaged at all and we ran as
      // fast as the network allowed, straight past Etherscan's per-second limit.
      // Clamped to delayMs: if the clock jumps backwards (NTP correction, or a
      // test faking timers) sinceLast goes negative and an unclamped
      // `delayMs - sinceLast` would sleep for the length of the jump, wedging
      // the queue. Never wait longer than a single interval.
      const sinceLast = Date.now() - this.lastRunAt;
      const wait = Math.min(Math.max(this.delayMs - sinceLast, 0), this.delayMs);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.lastRunAt = Date.now();

      try {
        const result = await task();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }

    this.isProcessing = false;
  }
}
