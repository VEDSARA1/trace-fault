/**
 * Shared error vocabulary. Routes map these to HTTP statuses:
 *   ConfigError    → 500 (our misconfiguration; never leak details)
 *   RateLimitError → 429 (upstream throttled us, or we shed load)
 *   EtherscanError → 502 (genuine upstream failure)
 *
 * These live outside the service so lower-level utilities (the request queue)
 * can throw them without importing the service and creating a cycle.
 */

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class EtherscanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EtherscanError';
  }
}
