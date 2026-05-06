/**
 * Base IdP adapter - abstract interface for upstream identity provider checks.
 * Used by sync-reconciler to verify JIT users still exist at source.
 * @module shared/idp-adapters/base-idp-adapter
 */

import { toISOString } from '../time-utils.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Structured error log for IdP adapter operations.
 * @param {string} adapter
 * @param {string} errorCode
 * @param {string} message
 * @param {object} [extra]
 */
const logAdapterError = (adapter, errorCode, message, extra = {}) => {
  console.error(JSON.stringify({
    errorCode,
    message,
    adapter,
    timestamp: toISOString(new Date()),
    ...extra,
  }));
};

/**
 * Structured info log for IdP adapter operations.
 * @param {string} adapter
 * @param {string} action
 * @param {object} [details]
 */
const logAdapterInfo = (adapter, action, details = {}) => {
  console.log(JSON.stringify({
    action,
    adapter,
    timestamp: toISOString(new Date()),
    ...details,
  }));
};

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compute backoff delay with jitter.
 * @param {number} attempt - Zero-based attempt index
 * @param {number} baseDelay - Base delay in ms
 * @returns {number} Delay in ms
 */
const computeBackoff = (attempt, baseDelay = BASE_DELAY_MS) => {
  const exponential = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelay;
  return exponential + jitter;
};

/**
 * Execute an async function with retry and exponential backoff.
 * @param {Function} fn - Async function to execute
 * @param {object} opts
 * @param {number} [opts.maxRetries]
 * @param {number} [opts.baseDelay]
 * @param {string} [opts.adapterName]
 * @returns {Promise<*>}
 */
const withRetry = async (fn, { maxRetries = DEFAULT_MAX_RETRIES, baseDelay = BASE_DELAY_MS, adapterName = 'unknown' } = {}) => {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = computeBackoff(attempt, baseDelay);
        logAdapterInfo(adapterName, 'RETRY', { attempt: attempt + 1, maxRetries, delayMs: Math.round(delay), error: error.message });
        await sleep(delay);
      }
    }
  }
  throw lastError;
};

/**
 * Base IdP adapter class. Subclasses must implement _checkUserExists, _getUser, _healthCheck.
 */
class BaseIdpAdapter {
  /**
   * @param {object} config
   * @param {string} config.endpoint - Base URL of the IdP API
   * @param {string} config.credentials - Credentials string (token, client secret, etc.)
   * @param {number} [config.timeoutMs] - Request timeout in ms
   * @param {number} [config.maxRetries] - Max retry attempts
   */
  constructor({ endpoint, credentials, timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES }) {
    this.endpoint = endpoint;
    this.credentials = credentials;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.adapterName = 'base';
  }

  /**
   * Check if a user exists at the upstream IdP.
   * @param {string} email
   * @returns {Promise<{ exists: boolean, userData?: object }>}
   */
  async checkUserExists(email) {
    return withRetry(() => this._checkUserExists(email), {
      maxRetries: this.maxRetries,
      adapterName: this.adapterName,
    });
  }

  /**
   * Get full user object from upstream IdP.
   * @param {string} email
   * @returns {Promise<object|null>}
   */
  async getUser(email) {
    return withRetry(() => this._getUser(email), {
      maxRetries: this.maxRetries,
      adapterName: this.adapterName,
    });
  }

  /**
   * Check connectivity to the upstream IdP.
   * @returns {Promise<{ healthy: boolean, latencyMs: number, error?: string }>}
   */
  async healthCheck() {
    const start = Date.now();
    try {
      const result = await this._healthCheck();
      return { healthy: true, latencyMs: Date.now() - start, ...result };
    } catch (error) {
      return { healthy: false, latencyMs: Date.now() - start, error: error.message };
    }
  }

  /**
   * Make an HTTP request with timeout using native fetch.
   * @param {string} url
   * @param {object} options - fetch options
   * @returns {Promise<Response>}
   */
  async _fetch(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Abstract methods - subclasses must override
  async _checkUserExists(_email) { throw new Error('Not implemented'); }
  async _getUser(_email) { throw new Error('Not implemented'); }
  async _healthCheck() { throw new Error('Not implemented'); }
}

export {
  BaseIdpAdapter,
  withRetry,
  computeBackoff,
  sleep,
  logAdapterError,
  logAdapterInfo,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
};
