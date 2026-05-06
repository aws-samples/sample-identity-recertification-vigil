/**
 * Base identity source adapter - abstract interface for internal identity sources.
 * Used by recertification workflow to enumerate, inspect, and disable users
 * in Cognito, IAM, and Identity Center.
 * @module shared/identity-adapters/base-adapter
 */

import { toISOString } from '../time-utils.mjs';

const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = parseInt(process.env.ADAPTER_RETRY_DELAY_MS || '1000', 10);

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compute exponential backoff delay with jitter.
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
 * @param {{ maxRetries?: number, baseDelay?: number, adapterName?: string }} opts
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
        console.log(JSON.stringify({
          action: 'IDENTITY_ADAPTER_RETRY',
          adapter: adapterName,
          attempt: attempt + 1,
          maxRetries,
          delayMs: Math.round(delay),
          error: error.message,
          timestamp: toISOString(new Date()),
        }));
        await sleep(delay);
      }
    }
  }
  throw lastError;
};

/**
 * @typedef {Object} NormalizedUser
 * @property {string} userId
 * @property {string} userName
 * @property {string} email
 * @property {string} identitySource - COGNITO | IAM | IDENTITY_CENTER
 * @property {string} [status]
 * @property {string[]} [groups]
 * @property {string} [createdAt]
 */

/**
 * @typedef {Object} UserGroup
 * @property {string} groupId
 * @property {string} groupName
 */

/**
 * @typedef {Object} DisableResult
 * @property {boolean} success
 * @property {string} disabledAt
 * @property {object} [details]
 */

/**
 * Base identity source adapter class.
 * Subclasses must implement listUsers, getUser, disableUser, getUserGroups.
 */
class BaseIdentityAdapter {
  constructor() {
    this.adapterName = 'base';
  }

  /**
   * List all users from this identity source.
   * @returns {Promise<NormalizedUser[]>}
   */
  async listUsers() {
    throw new Error('NotImplementedError: listUsers() must be implemented by subclass');
  }

  /**
   * Get a single user by ID.
   * @param {string} id - User identifier
   * @returns {Promise<NormalizedUser>}
   */
  async getUser(id) {
    throw new Error('NotImplementedError: getUser() must be implemented by subclass');
  }

  /**
   * Disable a user (revoke access).
   * @param {string} id - User identifier
   * @returns {Promise<DisableResult>}
   */
  async disableUser(id) {
    throw new Error('NotImplementedError: disableUser() must be implemented by subclass');
  }

  /**
   * Get groups for a user.
   * @param {string} id - User identifier
   * @returns {Promise<UserGroup[]>}
   */
  async getUserGroups(id) {
    throw new Error('NotImplementedError: getUserGroups() must be implemented by subclass');
  }
}

export {
  BaseIdentityAdapter,
  withRetry,
  computeBackoff,
  sleep,
  DEFAULT_MAX_RETRIES,
  BASE_DELAY_MS,
};
