import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: __dirname,
    environment: 'node',
    // Disable the Etherscan throttle in tests: the shared queue's real sleep
    // deadlocks under vi.useFakeTimers(), and no test should pay for it. The
    // spacing logic is covered directly against a RequestQueue instance.
    // Retries are off by default here too, so a test asserting a RateLimitError
    // sees it immediately; the retry path has its own test that opts back in.
    env: { ETHERSCAN_QUEUE_DELAY_MS: '0', ETHERSCAN_RATE_LIMIT_RETRIES: '0' },
  },
});
