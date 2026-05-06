/**
 * API client with Cognito auth headers.
 * All API calls go through this utility.
 * Base URL configurable via VITE_API_URL environment variable.
 * @module utils/api
 */

import { fetchAuthSession } from '@aws-amplify/auth';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

/**
 * Get the current Cognito ID token for API authorization.
 * @returns {Promise<string|null>}
 */
const getAuthToken = async () => {
  try {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() || null;
  } catch {
    return null;
  }
};

/**
 * Make an authenticated API request.
 * @param {string} path - API path (e.g. '/dashboard/summary')
 * @param {object} [options] - Fetch options
 * @param {string} [options.method='GET'] - HTTP method
 * @param {object} [options.params] - Query string parameters
 * @param {object} [options.body] - Request body (will be JSON-stringified)
 * @returns {Promise<object>} Parsed JSON response
 * @throws {ApiError} On non-2xx responses
 */
export const apiRequest = async (path, options = {}) => {
  const { method = 'GET', params, body } = options;

  let url = `${API_BASE_URL}${path}`;
  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        searchParams.set(key, String(value));
      }
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  const token = await getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = token;
  }

  const fetchOptions = { method, headers };
  if (body) {
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const error = new Error(errorBody.error || `API error: ${response.status}`);
    error.status = response.status;
    error.body = errorBody;
    throw error;
  }

  // Handle binary responses (CSV, PDF)
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('text/csv') || contentType.includes('application/pdf')) {
    return response.blob();
  }

  return response.json();
};

// Convenience methods 

/** Dashboard summary */
export const getDashboardSummary = () =>
  apiRequest('/dashboard/summary');

/** Dashboard event timeline */
export const getDashboardTimeline = (period = '30d', groupBy = 'day') =>
  apiRequest('/dashboard/events/timeline', { params: { period, groupBy } });

/** Dashboard user distribution */
export const getDashboardDistribution = () =>
  apiRequest('/dashboard/users/distribution');

/** Search users */
export const searchUsers = (q, { source, status, limit, lastKey } = {}) =>
  apiRequest('/search/users', { params: { q, source, status, limit, lastKey } });

/** User detail */
export const getUserDetail = (userId) =>
  apiRequest(`/users/${userId}/detail`);

/** User timeline */
export const getUserTimeline = (userId, { limit, lastKey, order } = {}) =>
  apiRequest(`/audit/users/${userId}/timeline`, { params: { limit, lastKey, order } });

/** Deletion proof */
export const getDeletionProof = (userId) =>
  apiRequest(`/audit/users/${userId}/deletion-proof`);

/** Export audit data */
export const exportAudit = (startDate, endDate, format = 'csv') =>
  apiRequest('/audit/export', { params: { startDate, endDate, format } });

// Recertification API 

/** Get current owner's pending reviews */
export const getMyReviews = (cycleId) =>
  apiRequest('/recert/my-reviews', { params: { cycleId } });

/** Get cycle details */
export const getCycleDetails = (cycleId) =>
  apiRequest(`/recert/cycles/${cycleId}`);

/** Submit recertification decisions (supports both resource-level and per-principal formats) */
export const submitDecisions = (cycleId, decisions, onBehalfOf) =>
  apiRequest('/recert/decisions', {
    method: 'POST',
    body: { cycleId, decisions, onBehalfOf },
  });

/** Request deadline extension */
export const requestExtension = (cycleId, reason) =>
  apiRequest(`/recert/cycles/${cycleId}/extend`, {
    method: 'POST',
    body: { reason },
  });

/** Transfer reviews to new owner */
export const transferReviews = (cycleId, oldOwnerEmail, newOwnerEmail) =>
  apiRequest(`/recert/cycles/${cycleId}/transfer`, {
    method: 'POST',
    body: { oldOwnerEmail, newOwnerEmail },
  });

/** Trigger manual/ad-hoc cycle */
export const triggerCycle = (cycleType, scope, deadline) =>
  apiRequest('/recert/cycles', {
    method: 'POST',
    body: { cycleType, scope, deadline },
  });

/** Get user recertification history */
export const getUserRecertHistory = (userId) =>
  apiRequest(`/recert/users/${userId}/history`);

/** Get recert dashboard summary */
export const getRecertSummary = () =>
  apiRequest('/dashboard/recert/summary');

// Admin API 

/** Get unowned resources */
export const getUnownedResources = () =>
  apiRequest('/admin/unowned');

/** Get all override assignments */
export const getOverrides = () =>
  apiRequest('/admin/overrides');

/** Create override assignment */
export const createOverride = (ownerEmail, resources) =>
  apiRequest('/admin/overrides', {
    method: 'POST',
    body: { ownerEmail, resources },
  });

/** Delete override assignment */
export const deleteOverride = (ownerEmail, userId) =>
  apiRequest(`/admin/overrides/${encodeURIComponent(ownerEmail)}/resources/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });

// Multi-Account Governance API 

/** Get all discovered accounts from Account Registry */
export const getAccounts = () =>
  apiRequest('/admin/accounts');

/** Trigger account discovery sync from AWS Organizations */
export const syncAccounts = () =>
  apiRequest('/admin/accounts/sync', { method: 'POST' });

/** Trigger on-demand resource scan for a specific account */
export const scanAccount = (accountId) =>
  apiRequest(`/admin/accounts/${encodeURIComponent(accountId)}/scan`, { method: 'POST' });
