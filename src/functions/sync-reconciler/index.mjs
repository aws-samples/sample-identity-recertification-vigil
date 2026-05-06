/**
 * Sync Reconciler Lambda - compares JIT users in Cognito against upstream IdP.
 * Detects orphaned accounts, auto-disables after two cycles, handles API endpoints.
 * Routes:
 *   Scheduled: EventBridge Scheduler (every 6 hours)
 *   GET /sync/orphaned - list orphaned accounts
 *   POST /sync/orphaned/{userId}/confirm-delete - admin hard-delete
 *   GET /sync/reconciliation/latest - latest reconciliation run
 *   GET /dashboard/sync/summary - sync health dashboard
 * @module functions/sync-reconciler
 */

import { PutCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ListUsersCommand, AdminDisableUserCommand, AdminUserGlobalSignOutCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { ddbClient, TABLE_NAME } from '../../shared/dynamo-client.mjs';
import { toISOString, toIST, toEpoch } from '../../shared/time-utils.mjs';
import { computeDeletionProofHash } from '../../shared/crypto-utils.mjs';
import {
  KEY_PREFIXES,
  SK_PREFIXES,
  ENTITY_TYPES,
  successResponse,
  errorResponse,
} from '../../shared/constants.mjs';

const cognitoClient = new CognitoIdentityProviderClient({});
const s3Client = new S3Client({});
const sesClient = new SESClient({});

const FUNCTION_NAME = 'sync-reconciler';
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET || '';
const SES_SENDER = process.env.SES_SENDER_EMAIL || '';
const GRACE_HOURS = parseInt(process.env.RECONCILIATION_GRACE_HOURS || '1', 10);
const AUTO_DISABLE_HOURS = 12; // Two 6-hour cycles

/** Structured error log */
const logError = (errorCode, message, userId) => {
  console.error(JSON.stringify({ errorCode, message, userId: userId || 'UNKNOWN', function: FUNCTION_NAME, timestamp: toISOString(new Date()) }));
};

/** Structured info log */
const logInfo = (action, details) => {
  console.log(JSON.stringify({ action, function: FUNCTION_NAME, timestamp: toISOString(new Date()), ...details }));
};

// Main handler 

/**
 * Main handler - routes by event type.
 * @param {object} event
 * @returns {object|void}
 */
export const handler = async (event) => {
  try {
    if (isScheduledEvent(event)) {
      return await runReconciliation();
    }
    const route = resolveRoute(event);
    if (!route) return errorResponse(404, 'Route not found');
    return await route(event);
  } catch (error) {
    logError('HANDLER_ERROR', error.message);
    return errorResponse(500, 'Internal server error');
  }
};

/**
 * Detect EventBridge Scheduler invocation.
 * @param {object} event
 * @returns {boolean}
 */
const isScheduledEvent = (event) => {
  return event.source === 'aws.scheduler'
    || event['detail-type'] === 'Scheduled Event'
    || event.source === 'aws.events'
    || (!event.httpMethod && !event.resource);
};

/**
 * Resolve API route handler.
 * @param {object} event
 * @returns {Function|null}
 */
const resolveRoute = (event) => {
  const resource = event.resource || '';
  const method = (event.httpMethod || '').toUpperCase();
  const routes = {
    'GET:/sync/orphaned': handleGetOrphaned,
    'POST:/sync/orphaned/{userId}/confirm-delete': handleConfirmDelete,
    'GET:/sync/reconciliation/latest': handleGetLatestReconciliation,
    'GET:/dashboard/sync/summary': handleDashboardSyncSummary,
  };
  return routes[`${method}:${resource}`] || null;
};

// Reconciliation engine 

/**
 * Run full reconciliation cycle.
 * @returns {Promise<void>}
 */
const runReconciliation = async () => {
  const startTime = Date.now();
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  const counters = { totalChecked: 0, confirmedActive: 0, newOrphans: 0, autoDisabled: 0, errors: [], skipped: 0 };

  logInfo('RECONCILIATION_START', { runId });

  let adapter;
  try {
    const { getIdpAdapter } = await import('../../shared/idp-adapters/index.mjs');
    adapter = await getIdpAdapter();
  } catch (error) {
    logError('IDP_ADAPTER_INIT_FAILED', error.message);
    await writeReconciliationSummary(runId, now, counters, Date.now() - startTime, 'IDP_UNAVAILABLE');
    return;
  }

  const jitUsers = await listJitUsers();
  counters.totalChecked = jitUsers.length;
  const perUserResults = [];

  for (const user of jitUsers) {
    const result = await reconcileUser(user, adapter, now, runId);
    perUserResults.push(result);
    updateCounters(counters, result);
  }

  const durationMs = Date.now() - startTime;
  await writeReconciliationSummary(runId, now, counters, durationMs, 'COMPLETED');
  await archivePerUserResults(runId, now, perUserResults);

  logInfo('RECONCILIATION_COMPLETE', { runId, ...counters, durationMs });
};

/**
 * List all JIT-provisioned users from Cognito.
 * @returns {Promise<object[]>}
 */
const listJitUsers = async () => {
  const users = [];
  let paginationToken;
  do {
    const params = { UserPoolId: USER_POOL_ID, Limit: 60 };
    if (paginationToken) params.PaginationToken = paginationToken;
    const result = await cognitoClient.send(new ListUsersCommand(params));
    const jit = (result.Users || []).filter((u) => {
      const attrs = Object.fromEntries((u.Attributes || []).map((a) => [a.Name, a.Value]));
      return attrs['custom:identitySource'] === 'JIT';
    });
    for (const u of jit) {
      const attrs = Object.fromEntries((u.Attributes || []).map((a) => [a.Name, a.Value]));
      users.push({ userId: attrs.sub || u.Username, email: attrs.email || '', username: u.Username, enabled: u.Enabled });
    }
    paginationToken = result.PaginationToken;
  } while (paginationToken);
  return users;
};

/**
 * Reconcile a single user against the upstream IdP.
 * @param {object} user - { userId, email, username, enabled }
 * @param {object} adapter - IdP adapter instance
 * @param {Date} now
 * @param {string} runId
 * @returns {Promise<object>} Per-user result
 */
const reconcileUser = async (user, adapter, now, runId) => {
  try {
    const idpResult = await adapter.checkUserExists(user.email);
    if (idpResult.exists) {
      return { userId: user.userId, email: user.email, status: 'ACTIVE', action: 'none' };
    }
    return await handleOrphanedUser(user, now, runId);
  } catch (error) {
    logError('IDP_CHECK_ERROR', error.message, user.userId);
    // IdP unavailable - skip, do NOT flag as orphan (FR-3 / B8)
    return { userId: user.userId, email: user.email, status: 'SKIPPED', action: 'none', error: error.message };
  }
};

/**
 * Handle a user not found at the upstream IdP.
 * @param {object} user
 * @param {Date} now
 * @param {string} runId
 * @returns {Promise<object>}
 */
const handleOrphanedUser = async (user, now, runId) => {
  const existing = await getOrphanRecord(user.userId);
  const graceMs = GRACE_HOURS * 60 * 60 * 1000;
  const autoDisableMs = AUTO_DISABLE_HOURS * 60 * 60 * 1000;

  if (!existing) {
    await writeOrphanRecord(user, now, 'ORPHANED_PENDING');
    await sendOrphanAlert(user, now);
    return { userId: user.userId, email: user.email, status: 'ORPHANED_PENDING', action: 'flagged' };
  }

  const detectedAt = new Date(existing.firstDetectedOrphanAt || existing.createdAt);
  const elapsed = now.getTime() - detectedAt.getTime();

  if (elapsed < graceMs) {
    return { userId: user.userId, email: user.email, status: 'ORPHANED_PENDING', action: 'within_grace' };
  }

  if (elapsed >= autoDisableMs && existing.status !== 'AUTO_DISABLED_ORPHAN') {
    await autoDisableUser(user, now, runId);
    return { userId: user.userId, email: user.email, status: 'AUTO_DISABLED_ORPHAN', action: 'auto_disabled' };
  }

  return { userId: user.userId, email: user.email, status: 'ORPHANED_PENDING', action: 'awaiting_auto_disable' };
};

/**
 * Get existing orphan record for a user.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
const getOrphanRecord = async (userId) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.USER}${userId}`,
      ':sk': `${SK_PREFIXES.SYNC}ORPHAN`,
    },
    ScanIndexForward: false,
    Limit: 1,
  }));
  return result.Items?.[0] || null;
};

/**
 * Write orphan detection record to DynamoDB.
 * @param {object} user
 * @param {Date} now
 * @param {string} status
 */
const writeOrphanRecord = async (user, now, status) => {
  const ts = toISOString(now);
  const record = {
    PK: `${KEY_PREFIXES.USER}${user.userId}`,
    SK: `${SK_PREFIXES.SYNC}ORPHAN#${ts}`,
    GSI1PK: `${KEY_PREFIXES.TYPE}ORPHANED`,
    GSI1SK: ts,
    GSI2PK: `SOURCE#JIT`,
    GSI2SK: user.userId,
    entityType: 'ORPHAN_RECORD',
    userId: user.userId,
    email: user.email,
    status,
    firstDetectedOrphanAt: ts,
    identitySource: 'JIT',
    createdAt: ts,
    createdAtEpoch: toEpoch(now),
    createdAtIST: toIST(now),
  };
  try {
    await ddbClient.send(new PutCommand({ TableName: TABLE_NAME, Item: record, ConditionExpression: 'attribute_not_exists(PK)' }));
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return;
    throw error;
  }
};

/**
 * Auto-disable a user in Cognito and create deletion proof.
 * @param {object} user
 * @param {Date} now
 * @param {string} runId
 */
const autoDisableUser = async (user, now, runId) => {
  await cognitoClient.send(new AdminDisableUserCommand({ UserPoolId: USER_POOL_ID, Username: user.username }));
  await cognitoClient.send(new AdminUserGlobalSignOutCommand({ UserPoolId: USER_POOL_ID, Username: user.username }));

  const ts = toISOString(now);
  const proofHash = computeDeletionProofHash(user.userId, ts, ts, 'RECONCILIATION', runId);

  const proofRecord = {
    PK: `${KEY_PREFIXES.USER}${user.userId}`,
    SK: `${SK_PREFIXES.DELETION_PROOF}${ts}`,
    GSI1PK: `${KEY_PREFIXES.TYPE}ORPHANED`,
    GSI1SK: ts,
    entityType: ENTITY_TYPES.DELETION_PROOF,
    userId: user.userId,
    email: user.email,
    status: 'AUTO_DISABLED_ORPHAN',
    sourceEvent: 'RECONCILIATION_ORPHAN',
    sourceDeletedAt: null,
    localDisabledAt: ts,
    reconciliationRunId: runId,
    proofHash,
    identitySource: 'JIT',
    createdAt: ts,
    createdAtEpoch: toEpoch(now),
    createdAtIST: toIST(now),
  };

  await ddbClient.send(new PutCommand({ TableName: TABLE_NAME, Item: proofRecord, ConditionExpression: 'attribute_not_exists(PK)' }));
  await sendOrphanAlert(user, now, 'AUTO_DISABLED');
  logInfo('AUTO_DISABLED_USER', { userId: user.userId, runId });
};

/**
 * Send orphan alert email via SES.
 * @param {object} user
 * @param {Date} now
 * @param {string} [alertType]
 */
const sendOrphanAlert = async (user, now, alertType = 'NEW_ORPHAN') => {
  if (!SES_SENDER) return;
  try {
    await sesClient.send(new SendEmailCommand({
      Source: SES_SENDER,
      Destination: { ToAddresses: [SES_SENDER] },
      Message: {
        Subject: { Data: `[IGS] Orphaned Account ${alertType}: ${user.email}` },
        Body: { Text: { Data: `User ${user.email} (${user.userId}) detected as orphaned at ${toISOString(now)}. Alert type: ${alertType}` } },
      },
    }));
  } catch (error) {
    logError('SES_ALERT_ERROR', error.message, user.userId);
  }
};

/**
 * Update counters from a per-user result.
 * @param {object} counters
 * @param {object} result
 */
const updateCounters = (counters, result) => {
  if (result.status === 'ACTIVE') counters.confirmedActive++;
  else if (result.action === 'flagged') counters.newOrphans++;
  else if (result.action === 'auto_disabled') counters.autoDisabled++;
  else if (result.status === 'SKIPPED') counters.skipped++;
  if (result.error) counters.errors.push({ userId: result.userId, error: result.error });
};

/**
 * Write reconciliation run summary to DynamoDB.
 * @param {string} runId
 * @param {Date} now
 * @param {object} counters
 * @param {number} durationMs
 * @param {string} status
 */
const writeReconciliationSummary = async (runId, now, counters, durationMs, status) => {
  const ts = toISOString(now);
  const dateStr = ts.slice(0, 10);
  const record = {
    PK: `${KEY_PREFIXES.RECONCILIATION}${dateStr}`,
    SK: `${SK_PREFIXES.RUN}${ts}`,
    entityType: ENTITY_TYPES.RECONCILIATION_RUN,
    runId,
    status,
    totalUsersChecked: counters.totalChecked,
    usersConfirmedActive: counters.confirmedActive,
    newOrphansDetected: counters.newOrphans,
    orphansAutoDisabled: counters.autoDisabled,
    skipped: counters.skipped,
    reconciliationDurationMs: durationMs,
    errors: counters.errors,
    createdAt: ts,
    createdAtEpoch: toEpoch(now),
    createdAtIST: toIST(now),
  };
  await ddbClient.send(new PutCommand({ TableName: TABLE_NAME, Item: record, ConditionExpression: 'attribute_not_exists(PK)' }));
};

/**
 * Archive per-user reconciliation results to S3.
 * @param {string} runId
 * @param {Date} now
 * @param {object[]} results
 */
const archivePerUserResults = async (runId, now, results) => {
  if (!EVIDENCE_BUCKET) return;
  const dateStr = toISOString(now).slice(0, 10);
  const key = `reconciliation/${dateStr}/${runId}.json`;
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: EVIDENCE_BUCKET,
      Key: key,
      Body: JSON.stringify({ runId, timestamp: toISOString(now), results }, null, 2),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));
    logInfo('S3_ARCHIVE_WRITTEN', { key, resultCount: results.length });
  } catch (error) {
    logError('S3_ARCHIVE_ERROR', error.message);
  }
};

// API endpoint handlers 

/**
 * GET /sync/orphaned - list all orphaned accounts.
 * @param {object} event
 * @returns {object}
 */
const handleGetOrphaned = async (event) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `${KEY_PREFIXES.TYPE}ORPHANED` },
    ScanIndexForward: false,
  }));

  const items = (result.Items || []).map(formatOrphanItem);
  logInfo('GET_ORPHANED', { count: items.length });
  return successResponse(200, { orphanedAccounts: items, count: items.length });
};

/**
 * Format an orphan record for API response.
 * @param {object} item
 * @returns {object}
 */
const formatOrphanItem = (item) => {
  const detectedAt = item.firstDetectedOrphanAt || item.createdAt;
  const daysSince = detectedAt ? Math.floor((Date.now() - new Date(detectedAt).getTime()) / (24 * 60 * 60 * 1000)) : 0;
  return {
    userId: item.userId,
    email: item.email,
    identitySource: item.identitySource || 'JIT',
    detectedAt,
    currentStatus: item.status,
    daysSinceDetected: daysSince,
    reconciliationRunId: item.reconciliationRunId || null,
  };
};

/**
 * POST /sync/orphaned/{userId}/confirm-delete - admin hard-delete.
 * @param {object} event
 * @returns {object}
 */
const handleConfirmDelete = async (event) => {
  const userId = event.pathParameters?.userId;
  if (!userId) return errorResponse(400, 'userId is required');

  const orphan = await getOrphanRecord(userId);
  if (!orphan) return errorResponse(404, 'No orphan record found for this user');

  const now = new Date();
  const ts = toISOString(now);

  // Delete user from Cognito
  try {
    await cognitoClient.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: orphan.email || userId }));
  } catch (error) {
    if (error.name !== 'UserNotFoundException') {
      logError('COGNITO_DELETE_ERROR', error.message, userId);
      return errorResponse(500, 'Failed to delete user from Cognito');
    }
  }

  // Create final deletion proof
  const proofHash = computeDeletionProofHash(userId, ts, ts, 'ADMIN_CONFIRM', 'manual');
  const proofRecord = {
    PK: `${KEY_PREFIXES.USER}${userId}`,
    SK: `${SK_PREFIXES.DELETION_PROOF}${ts}`,
    GSI1PK: `${KEY_PREFIXES.TYPE}DELETION_PROOF`,
    GSI1SK: ts,
    entityType: ENTITY_TYPES.DELETION_PROOF,
    userId,
    email: orphan.email,
    status: 'ADMIN_CONFIRMED_DELETE',
    sourceEvent: 'ADMIN_CONFIRMATION',
    localDeletedAt: ts,
    proofHash,
    identitySource: orphan.identitySource || 'JIT',
    createdAt: ts,
    createdAtEpoch: toEpoch(now),
    createdAtIST: toIST(now),
  };

  await ddbClient.send(new PutCommand({ TableName: TABLE_NAME, Item: proofRecord, ConditionExpression: 'attribute_not_exists(PK)' }));

  // Archive evidence to S3
  if (EVIDENCE_BUCKET) {
    const year = ts.slice(0, 4);
    const month = ts.slice(5, 7);
    const key = `evidence/${year}/${month}/${userId}/DELETION_PROOF_${ts.replace(/[:.]/g, '-')}.json`;
    await s3Client.send(new PutObjectCommand({
      Bucket: EVIDENCE_BUCKET,
      Key: key,
      Body: JSON.stringify(proofRecord, null, 2),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));
  }

  logInfo('CONFIRM_DELETE', { userId });
  return successResponse(200, { userId, status: 'ADMIN_CONFIRMED_DELETE', deletedAt: ts, proofHash });
};

/**
 * GET /sync/reconciliation/latest - most recent reconciliation run.
 * @param {object} event
 * @returns {object}
 */
const handleGetLatestReconciliation = async (event) => {
  const today = toISOString(new Date()).slice(0, 10);
  // Query today and recent dates
  const dates = getRecentDates(today, 7);
  let latest = null;

  for (const date of dates) {
    const result = await ddbClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `${KEY_PREFIXES.RECONCILIATION}${date}` },
      ScanIndexForward: false,
      Limit: 1,
    }));
    if (result.Items?.length > 0) {
      latest = result.Items[0];
      break;
    }
  }

  if (!latest) {
    return successResponse(200, { reconciliation: null, message: 'No reconciliation runs found' });
  }

  return successResponse(200, {
    reconciliation: {
      runId: latest.runId,
      timestamp: latest.createdAt,
      status: latest.status,
      totalUsersChecked: latest.totalUsersChecked,
      usersConfirmedActive: latest.usersConfirmedActive,
      newOrphansDetected: latest.newOrphansDetected,
      orphansAutoDisabled: latest.orphansAutoDisabled,
      reconciliationDurationMs: latest.reconciliationDurationMs,
      errors: latest.errors || [],
    },
  });
};

/**
 * GET /dashboard/sync/summary - sync health for dashboard.
 * @param {object} event
 * @returns {object}
 */
const handleDashboardSyncSummary = async (event) => {
  const [orphanResult, latestRecon] = await Promise.all([
    ddbClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `${KEY_PREFIXES.TYPE}ORPHANED` },
      Select: 'COUNT',
    })),
    handleGetLatestReconciliation({}),
  ]);

  const reconData = JSON.parse(latestRecon.body);
  return successResponse(200, {
    orphanCount: orphanResult.Count || 0,
    lastReconciliation: reconData.data?.reconciliation || null,
  });
};

/**
 * Get recent date strings for querying reconciliation records.
 * @param {string} today - YYYY-MM-DD
 * @param {number} days
 * @returns {string[]}
 */
const getRecentDates = (today, days) => {
  const dates = [];
  const d = new Date(today + 'T00:00:00Z');
  for (let i = 0; i < days; i++) {
    dates.push(toISOString(new Date(d.getTime() - i * 24 * 60 * 60 * 1000)).slice(0, 10));
  }
  return dates;
};

// Exported for testing
export {
  isScheduledEvent,
  resolveRoute,
  runReconciliation,
  listJitUsers,
  reconcileUser,
  handleOrphanedUser,
  getOrphanRecord,
  writeOrphanRecord,
  autoDisableUser,
  sendOrphanAlert,
  updateCounters,
  writeReconciliationSummary,
  archivePerUserResults,
  handleGetOrphaned,
  handleConfirmDelete,
  handleGetLatestReconciliation,
  handleDashboardSyncSummary,
  formatOrphanItem,
  getRecentDates,
};
