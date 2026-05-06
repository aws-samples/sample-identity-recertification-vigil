/**
 * Bulk Import Scanner Lambda - backfills missing audit records for CSV-imported users.
 * Scheduled every 15 minutes via EventBridge Scheduler.
 * Compares Cognito ListUsers against DynamoDB audit records and creates
 * LIFECYCLE_EVENT records with source=BULK_IMPORT for any missing users.
 * @module functions/bulk-import-scanner
 */

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddbClient, TABLE_NAME } from '../../shared/dynamo-client.mjs';
import { buildAuditRecord, buildEmailLookupRecord } from '../../shared/models.mjs';
import { toISOString } from '../../shared/time-utils.mjs';
import { EVENT_TYPES, IDENTITY_SOURCES, KEY_PREFIXES, SK_PREFIXES } from '../../shared/constants.mjs';

const FUNCTION_NAME = 'bulk-import-scanner';
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const PAGE_LIMIT = 60; // Cognito ListUsers max per page

const cognitoClient = new CognitoIdentityProviderClient({});

/**
 * Structured error log entry.
 * @param {string} errorCode
 * @param {string} message
 * @param {string} [userId]
 */
const logError = (errorCode, message, userId) => {
  console.error(JSON.stringify({
    errorCode,
    message,
    userId: userId || 'UNKNOWN',
    function: FUNCTION_NAME,
    timestamp: toISOString(new Date()),
  }));
};

/**
 * Structured info log entry.
 * @param {string} action
 * @param {object} details
 */
const logInfo = (action, details) => {
  console.log(JSON.stringify({
    action,
    function: FUNCTION_NAME,
    timestamp: toISOString(new Date()),
    ...details,
  }));
};

/**
 * Main handler - triggered by EventBridge Scheduler every 15 minutes.
 * @param {object} event - EventBridge scheduled event
 * @returns {Promise<void>}
 */
export const handler = async (event) => {
  logInfo('SCAN_START', { userPoolId: USER_POOL_ID });

  if (!USER_POOL_ID) {
    logError('MISSING_CONFIG', 'COGNITO_USER_POOL_ID environment variable not set');
    return;
  }

  try {
    const stats = await scanAndBackfill();
    logInfo('SCAN_COMPLETE', stats);
  } catch (error) {
    logError('SCAN_FAILED', error.message);
    throw error;
  }
};

/**
 * Scan all Cognito users and backfill missing audit records.
 * @returns {Promise<{ totalUsers: number, backfilled: number, skipped: number, errors: number }>}
 */
export const scanAndBackfill = async () => {
  let totalUsers = 0;
  let backfilled = 0;
  let skipped = 0;
  let errors = 0;
  let paginationToken = undefined;

  do {
    const page = await listCognitoUsers(paginationToken);
    const users = page.Users || [];
    totalUsers += users.length;

    for (const user of users) {
      try {
        const result = await processUser(user);
        if (result === 'backfilled') {
          backfilled++;
        } else {
          skipped++;
        }
      } catch (error) {
        logError('USER_PROCESS_ERROR', error.message, user.Username);
        errors++;
      }
    }

    paginationToken = page.PaginationToken;
  } while (paginationToken);

  return { totalUsers, backfilled, skipped, errors };
};

/**
 * List Cognito users with pagination.
 * @param {string|undefined} paginationToken
 * @returns {Promise<object>} ListUsers response
 */
export const listCognitoUsers = async (paginationToken) => {
  const params = {
    UserPoolId: USER_POOL_ID,
    Limit: PAGE_LIMIT,
  };

  if (paginationToken) {
    params.PaginationToken = paginationToken;
  }

  return cognitoClient.send(new ListUsersCommand(params));
};

/**
 * Process a single Cognito user - check if audit record exists, backfill if missing.
 * @param {object} user - Cognito user object from ListUsers
 * @returns {Promise<'backfilled'|'skipped'>}
 */
export const processUser = async (user) => {
  const userId = extractUserId(user);
  if (!userId) {
    logInfo('SKIP_NO_SUB', { username: user.Username });
    return 'skipped';
  }

  const hasAuditRecord = await checkAuditRecordExists(userId);
  if (hasAuditRecord) {
    return 'skipped';
  }

  await backfillAuditRecord(user, userId);
  return 'backfilled';
};

/**
 * Extract the user's sub (userId) from Cognito user attributes.
 * @param {object} user - Cognito user object
 * @returns {string|null}
 */
export const extractUserId = (user) => {
  const subAttr = (user.Attributes || []).find((attr) => attr.Name === 'sub');
  return subAttr?.Value || null;
};

/**
 * Extract email from Cognito user attributes.
 * @param {object} user - Cognito user object
 * @returns {string|null}
 */
export const extractEmail = (user) => {
  const emailAttr = (user.Attributes || []).find((attr) => attr.Name === 'email');
  return emailAttr?.Value || null;
};

/**
 * Check if a LIFECYCLE audit record exists for the given userId.
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export const checkAuditRecordExists = async (userId) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.USER}${userId}`,
      ':skPrefix': SK_PREFIXES.LIFECYCLE,
    },
    Select: 'COUNT',
    Limit: 1,
  }));

  return (result.Count || 0) > 0;
};

/**
 * Backfill a missing audit record for a Cognito user.
 * Uses the user's UserCreateDate as the event timestamp.
 * @param {object} user - Cognito user object
 * @param {string} userId - User's sub attribute
 */
export const backfillAuditRecord = async (user, userId) => {
  const email = extractEmail(user);
  const timestamp = user.UserCreateDate
    ? new Date(user.UserCreateDate)
    : new Date();

  const userAttributes = {};
  for (const attr of user.Attributes || []) {
    userAttributes[attr.Name] = attr.Value;
  }

  const auditRecord = buildAuditRecord({
    userId,
    eventType: EVENT_TYPES.CREATED,
    source: IDENTITY_SOURCES.COGNITO,
    email,
    actorId: 'SYSTEM',
    newState: {
      ...userAttributes,
      status: user.UserStatus || 'CONFIRMED',
      enabled: user.Enabled !== false,
    },
    metadata: {
      backfillSource: 'BULK_IMPORT',
      cognitoUsername: user.Username,
      userCreateDate: toISOString(timestamp),
      scanTimestamp: toISOString(new Date()),
    },
    timestamp,
  });

  await writeAuditRecord(auditRecord, userId);

  if (email) {
    await writeEmailLookup(email, userId);
  }

  logInfo('BACKFILL_CREATED', { userId, email, userCreateDate: toISOString(timestamp) });
};

/**
 * Write audit record to DynamoDB with deduplication.
 * @param {object} record - Complete DynamoDB item
 * @param {string} userId - For error logging
 */
const writeAuditRecord = async (record, userId) => {
  try {
    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      logInfo('DUPLICATE_SKIPPED', { userId, SK: record.SK });
      return;
    }
    logError('DYNAMO_WRITE_ERROR', error.message, userId);
    throw error;
  }
};

/**
 * Write email-to-userId lookup record with conditional write.
 * @param {string} email
 * @param {string} userId
 */
const writeEmailLookup = async (email, userId) => {
  try {
    const lookupRecord = buildEmailLookupRecord(email, userId);
    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: lookupRecord,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      logInfo('EMAIL_LOOKUP_EXISTS', { email, userId });
      return;
    }
    logError('EMAIL_LOOKUP_WRITE_ERROR', error.message, userId);
  }
};
