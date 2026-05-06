/**
 * Audit Writer Lambda - writes immutable lifecycle audit records to DynamoDB.
 * Handles two event sources:
 *   1. Cognito PostConfirmation trigger (user creation)
 *   2. EventBridge/CloudTrail events (modifications, deletions, SCIM)
 * @module functions/audit-writer
 */

import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ddbClient, TABLE_NAME } from '../../shared/dynamo-client.mjs';
import { buildAuditRecord, buildEmailLookupRecord } from '../../shared/models.mjs';
import { truncateToSecond, toISOString, toIST, toEpoch } from '../../shared/time-utils.mjs';
import { computeDeletionProofHash } from '../../shared/crypto-utils.mjs';
import { EVENT_TYPES, IDENTITY_SOURCES, KEY_PREFIXES, SK_PREFIXES, ENTITY_TYPES } from '../../shared/constants.mjs';

const s3Client = new S3Client({});
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET || '';

const FUNCTION_NAME = 'audit-writer';

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
 * Main handler - routes by event source.
 * @param {object} event - Lambda event (Cognito trigger or EventBridge)
 * @param {object} context - Lambda context
 * @returns {object|void} Returns event for Cognito triggers, void for EventBridge
 */
export const handler = async (event, context) => {
  try {
    if (isCognitoPostConfirmation(event)) {
      return await handleCognitoPostConfirmation(event, context);
    }

    if (isEventBridgeEvent(event)) {
      await handleCloudTrailEvent(event);
      return;
    }

    logError('UNKNOWN_EVENT_SOURCE', 'Unrecognized event source');
  } catch (error) {
    logError('HANDLER_ERROR', error.message);
    // Re-throw for Cognito triggers so Cognito sees the failure
    if (isCognitoPostConfirmation(event)) {
      throw error;
    }
  }
};

/**
 * Detect Cognito PostConfirmation trigger events.
 * @param {object} event
 * @returns {boolean}
 */
const isCognitoPostConfirmation = (event) => {
  return event.triggerSource === 'PostConfirmation_ConfirmSignUp'
    || event.triggerSource === 'PostConfirmation_ConfirmForgotPassword';
};

/**
 * Detect EventBridge/CloudTrail events.
 * @param {object} event
 * @returns {boolean}
 */
const isEventBridgeEvent = (event) => {
  return event.source === 'aws.cognito-idp'
    || event.source === 'aws.sso-directory'
    || event['detail-type'] === 'AWS API Call via CloudTrail';
};

/**
 * Handle Cognito PostConfirmation trigger - extract user data and write audit record.
 * Detects re-provisioning of previously deleted users.
 * @param {object} event - Cognito trigger event
 * @param {object} context - Lambda context
 * @returns {object} The original event (required by Cognito)
 */
const handleCognitoPostConfirmation = async (event, context) => {
  const userAttributes = event.request?.userAttributes || {};
  const userId = userAttributes.sub;
  const email = userAttributes.email;

  if (!userId) {
    logError('MISSING_USER_ID', 'No sub in userAttributes');
    return event;
  }

  const source = determineCognitoSource(event);
  const actorId = extractCognitoActorId(event, context);

  // Check for re-provisioning of previously deleted email
  const reprovisionInfo = email ? await checkReprovisioning(email, userId) : null;

  const metadata = {
    triggerSource: event.triggerSource,
    userPoolId: event.userPoolId,
  };

  if (reprovisionInfo) {
    metadata.reprovisioned = true;
    metadata.previousGovernanceId = reprovisionInfo.previousGovernanceId;
    metadata.newGovernanceId = reprovisionInfo.newGovernanceId;
    metadata.previousUserId = reprovisionInfo.previousUserId;
  }

  const auditRecord = buildAuditRecord({
    userId,
    eventType: EVENT_TYPES.CREATED,
    source,
    email,
    actorId,
    newState: userAttributes,
    metadata,
  });

  if (reprovisionInfo) {
    auditRecord.governanceId = reprovisionInfo.newGovernanceId;
    auditRecord.previousGovernanceId = reprovisionInfo.previousGovernanceId;
  }

  await writeAuditRecord(auditRecord, userId);

  if (email) {
    await writeEmailLookup(email, userId);
  }

  // Create admin alert for re-provisioned users
  if (reprovisionInfo) {
    await createReprovisioningAlert(userId, email, reprovisionInfo);
  }

  logInfo('COGNITO_POST_CONFIRMATION', { userId, source, eventType: EVENT_TYPES.CREATED, reprovisioned: !!reprovisionInfo });
  return event;
};

/**
 * Check if a previously deleted user with the same email exists.
 * @param {string} email
 * @param {string} newUserId
 * @returns {Promise<object|null>} Re-provisioning info or null
 */
const checkReprovisioning = async (email, newUserId) => {
  // Query EMAIL#{email} to find previous user records
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `${KEY_PREFIXES.EMAIL}${email.toLowerCase()}` },
  }));

  const lookups = result.Items || [];
  for (const lookup of lookups) {
    const prevUserId = lookup.userId || lookup.SK?.replace(KEY_PREFIXES.USER, '');
    if (!prevUserId || prevUserId === newUserId) continue;

    // Check if previous user has DELETED status
    const lifecycleResult = await ddbClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `${KEY_PREFIXES.USER}${prevUserId}`,
        ':sk': SK_PREFIXES.LIFECYCLE,
      },
      ScanIndexForward: false,
      Limit: 1,
    }));

    const latestEvent = lifecycleResult.Items?.[0];
    if (latestEvent && (latestEvent.eventType === EVENT_TYPES.DELETED || latestEvent.eventType === EVENT_TYPES.DISABLED)) {
      const { randomUUID } = await import('node:crypto');
      return {
        previousUserId: prevUserId,
        previousGovernanceId: latestEvent.governanceId || prevUserId,
        newGovernanceId: randomUUID(),
      };
    }
  }
  return null;
};

/**
 * Create admin review alert for re-provisioned user.
 * @param {string} userId
 * @param {string} email
 * @param {object} info
 */
const createReprovisioningAlert = async (userId, email, info) => {
  const now = new Date();
  const ts = toISOString(now);
  const alertRecord = {
    PK: `${KEY_PREFIXES.TYPE}REPROVISIONED_ALERT`,
    SK: ts,
    entityType: ENTITY_TYPES.ALERT,
    userId,
    email,
    previousGovernanceId: info.previousGovernanceId,
    newGovernanceId: info.newGovernanceId,
    previousUserId: info.previousUserId,
    flagMessage: 'Previously deleted user re-provisioned',
    status: 'PENDING_REVIEW',
    createdAt: ts,
    createdAtEpoch: toEpoch(now),
    createdAtIST: toIST(now),
  };

  try {
    await ddbClient.send(new PutCommand({ TableName: TABLE_NAME, Item: alertRecord, ConditionExpression: 'attribute_not_exists(PK) OR attribute_not_exists(SK)' }));
    logInfo('REPROVISIONING_ALERT_CREATED', { userId, email, previousUserId: info.previousUserId });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return;
    logError('REPROVISIONING_ALERT_ERROR', error.message, userId);
  }
};

/**
 * Determine identity source from Cognito trigger metadata.
 * @param {object} event
 * @returns {string} IDENTITY_SOURCES value
 */
const determineCognitoSource = (event) => {
  const clientMetadata = event.request?.clientMetadata || {};

  if (clientMetadata.source === 'admin') {
    return IDENTITY_SOURCES.COGNITO;
  }
  if (clientMetadata.source === 'jit' || event.request?.userAttributes?.identities) {
    return IDENTITY_SOURCES.JIT;
  }
  // ASSUMPTION: Default to COGNITO for self-signup when no metadata indicates otherwise
  return IDENTITY_SOURCES.COGNITO;
};

/**
 * Extract actor ID from Cognito trigger context.
 * @param {object} event
 * @param {object} context
 * @returns {string}
 */
const extractCognitoActorId = (event, context) => {
  const clientMetadata = event.request?.clientMetadata || {};
  if (clientMetadata.actorId) {
    return clientMetadata.actorId;
  }
  if (event.callerContext?.clientId) {
    return event.callerContext.clientId;
  }
  return 'SYSTEM';
};

/**
 * Handle CloudTrail events routed via EventBridge.
 * Supports aws.cognito-idp and aws.sso-directory event sources.
 * @param {object} event - EventBridge event
 */
const handleCloudTrailEvent = async (event) => {
  const detail = event.detail || {};
  const eventSource = detail.eventSource || '';
  const eventName = detail.eventName || '';

  if (eventSource === 'cognito-idp.amazonaws.com') {
    await handleCognitoCloudTrailEvent(detail, eventName);
    return;
  }

  if (eventSource === 'sso-directory.amazonaws.com'
    || eventSource === 'identitystore-scim.amazonaws.com') {
    await handleScimEvent(detail, eventName);
    return;
  }

  logError('UNSUPPORTED_EVENT_SOURCE', `Unsupported CloudTrail event source: ${eventSource}`);
};

/**
 * Handle Cognito CloudTrail events (AdminUpdateUserAttributes, AdminDeleteUser, etc.).
 * @param {object} detail - CloudTrail event detail
 * @param {string} eventName
 */
const handleCognitoCloudTrailEvent = async (detail, eventName) => {
  const mapping = mapCognitoEventType(eventName);
  if (!mapping) {
    logInfo('SKIPPED_EVENT', { eventName, reason: 'unmapped Cognito event' });
    return;
  }

  const requestParams = detail.requestParameters || {};
  const responseElements = detail.responseElements || {};
  const userId = requestParams.username || requestParams.userName || '';
  const actorId = extractCloudTrailActorId(detail);

  if (!userId) {
    logError('MISSING_USER_ID', `No userId in CloudTrail event: ${eventName}`);
    return;
  }

  const auditRecord = buildAuditRecord({
    userId,
    eventType: mapping.eventType,
    source: IDENTITY_SOURCES.COGNITO,
    actorId,
    previousState: mapping.eventType === EVENT_TYPES.MODIFIED ? requestParams : null,
    newState: responseElements || null,
    changedFields: extractChangedFields(requestParams),
    metadata: {
      cloudTrailEventId: detail.eventID,
      eventName,
      awsRegion: detail.awsRegion,
    },
    timestamp: detail.eventTime,
  });

  await writeAuditRecord(auditRecord, userId);
  logInfo('COGNITO_CLOUDTRAIL_EVENT', { userId, eventType: mapping.eventType, eventName });
};

/**
 * Map Cognito CloudTrail event names to lifecycle event types.
 * @param {string} eventName
 * @returns {{ eventType: string }|null}
 */
const mapCognitoEventType = (eventName) => {
  const map = {
    AdminUpdateUserAttributes: { eventType: EVENT_TYPES.MODIFIED },
    AdminDeleteUser: { eventType: EVENT_TYPES.DELETED },
    AdminCreateUser: { eventType: EVENT_TYPES.CREATED },
    AdminDisableUser: { eventType: EVENT_TYPES.DISABLED },
    AdminEnableUser: { eventType: EVENT_TYPES.MODIFIED },
  };
  return map[eventName] || null;
};

/**
 * Handle SCIM events from Identity Center (sso-directory / identitystore-scim).
 * Extracts userId from onBehalfOf element per July 2025 CloudTrail changes.
 * Creates deletion proof records for DeleteUser and DISABLED_AT_SOURCE for UpdateUser active=false.
 * @param {object} detail - CloudTrail event detail
 * @param {string} eventName
 */
const handleScimEvent = async (detail, eventName) => {
  const isDisableEvent = eventName === 'UpdateUser' && isScimDisableEvent(detail);
  const mapping = isDisableEvent
    ? { eventType: EVENT_TYPES.DISABLED_AT_SOURCE }
    : mapScimEventType(eventName);

  if (!mapping) {
    logInfo('SKIPPED_EVENT', { eventName, reason: 'unmapped SCIM event' });
    return;
  }

  const userId = extractScimUserId(detail);
  const actorId = extractCloudTrailActorId(detail);

  if (!userId) {
    logError('MISSING_USER_ID', `No userId in SCIM event: ${eventName}`);
    return;
  }

  const requestParams = detail.requestParameters || {};
  const responseElements = detail.responseElements || {};

  const auditRecord = buildAuditRecord({
    userId,
    eventType: mapping.eventType,
    source: IDENTITY_SOURCES.SCIM,
    actorId,
    newState: responseElements || null,
    changedFields: extractChangedFields(requestParams),
    metadata: {
      cloudTrailEventId: detail.eventID,
      eventName,
      eventSource: detail.eventSource,
      scimCorrelationId: detail.requestID || null,
    },
    timestamp: detail.eventTime,
  });

  await writeAuditRecord(auditRecord, userId);

  const email = extractScimEmail(detail);
  if (email) {
    await writeEmailLookup(email, userId);
  }

  // Create deletion proof for DeleteUser events
  if (eventName === 'DeleteUser') {
    await createDeletionProof(userId, email, detail);
  }

  // Create DISABLED_AT_SOURCE follow-up for disable events
  if (isDisableEvent) {
    await createDisableFollowUp(userId, email, detail);
  }

  logInfo('SCIM_EVENT', { userId, eventType: mapping.eventType, eventName });
};

/**
 * Detect if a SCIM UpdateUser event is a disable (active=false).
 * @param {object} detail
 * @returns {boolean}
 */
const isScimDisableEvent = (detail) => {
  const requestParams = detail.requestParameters || {};
  if (requestParams.active === false) return true;
  const ops = requestParams.operations || requestParams.Operations || [];
  return ops.some((op) => op.path === 'active' && op.value === false);
};

/**
 * Create a DELETION_PROOF record for a SCIM DeleteUser event.
 * @param {string} userId
 * @param {string|null} email
 * @param {object} detail - CloudTrail detail
 */
const createDeletionProof = async (userId, email, detail) => {
  const now = new Date();
  const ts = toISOString(now);
  const sourceTimestamp = detail.eventTime || ts;
  const cloudTrailEventId = detail.eventID || '';

  const proofHash = computeDeletionProofHash(userId, sourceTimestamp, ts, cloudTrailEventId, 'SCIM_DELETE');

  const proofRecord = {
    PK: `${KEY_PREFIXES.USER}${userId}`,
    SK: `${SK_PREFIXES.DELETION_PROOF}${ts}`,
    GSI1PK: `${KEY_PREFIXES.TYPE}DELETION_PROOF`,
    GSI1SK: ts,
    entityType: ENTITY_TYPES.DELETION_PROOF,
    userId,
    email: email || null,
    status: 'DELETION_CONFIRMED',
    sourceEvent: 'SCIM_DELETE',
    sourceTimestamp,
    identityCenterDeletedAt: ts,
    cloudTrailEventId,
    reconciliationRunId: 'SCIM_DELETE',
    proofHash,
    identitySource: 'SCIM',
    createdAt: ts,
    createdAtEpoch: toEpoch(now),
    createdAtIST: toIST(now),
  };

  try {
    await ddbClient.send(new PutCommand({ TableName: TABLE_NAME, Item: proofRecord, ConditionExpression: 'attribute_not_exists(PK)' }));
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return;
    logError('DELETION_PROOF_WRITE_ERROR', error.message, userId);
    throw error;
  }

  // Archive to S3
  await archiveDeletionProof(proofRecord);
  logInfo('DELETION_PROOF_CREATED', { userId, status: 'DELETION_CONFIRMED' });
};

/**
 * Create a follow-up check record for SCIM disable events.
 * If not deleted within 24 hours, escalate to admin.
 * @param {string} userId
 * @param {string|null} email
 * @param {object} detail
 */
const createDisableFollowUp = async (userId, email, detail) => {
  const now = new Date();
  const ts = toISOString(now);

  const followUpRecord = {
    PK: `${KEY_PREFIXES.USER}${userId}`,
    SK: `${SK_PREFIXES.SYNC}DISABLE_FOLLOWUP#${ts}`,
    GSI1PK: `${KEY_PREFIXES.TYPE}DISABLED_AT_SOURCE`,
    GSI1SK: ts,
    entityType: 'DISABLE_FOLLOWUP',
    userId,
    email: email || null,
    status: 'PENDING_REVIEW',
    flagMessage: 'Source disabled but not deleted - confirm intent',
    disabledAt: detail.eventTime || ts,
    cloudTrailEventId: detail.eventID || '',
    escalateAfter: toISOString(new Date(now.getTime() + 24 * 60 * 60 * 1000)),
    createdAt: ts,
    createdAtEpoch: toEpoch(now),
    createdAtIST: toIST(now),
  };

  try {
    await ddbClient.send(new PutCommand({ TableName: TABLE_NAME, Item: followUpRecord, ConditionExpression: 'attribute_not_exists(PK)' }));
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return;
    logError('DISABLE_FOLLOWUP_WRITE_ERROR', error.message, userId);
  }
  logInfo('DISABLE_FOLLOWUP_CREATED', { userId, escalateAfter: followUpRecord.escalateAfter });
};

/**
 * Archive deletion proof record to S3 with Object Lock.
 * @param {object} proofRecord
 */
const archiveDeletionProof = async (proofRecord) => {
  if (!EVIDENCE_BUCKET) return;
  const ts = proofRecord.createdAt;
  const year = ts.slice(0, 4);
  const month = ts.slice(5, 7);
  const key = `evidence/${year}/${month}/${proofRecord.userId}/DELETION_PROOF_${ts.replace(/[:.]/g, '-')}.json`;
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: EVIDENCE_BUCKET,
      Key: key,
      Body: JSON.stringify(proofRecord, null, 2),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }));
    logInfo('DELETION_PROOF_ARCHIVED', { key, userId: proofRecord.userId });
  } catch (error) {
    logError('S3_ARCHIVE_ERROR', error.message, proofRecord.userId);
  }
};

/**
 * Map SCIM event names to lifecycle event types.
 * @param {string} eventName
 * @returns {{ eventType: string }|null}
 */
const mapScimEventType = (eventName) => {
  const map = {
    CreateUser: { eventType: EVENT_TYPES.CREATED },
    UpdateUser: { eventType: EVENT_TYPES.MODIFIED },
    DeleteUser: { eventType: EVENT_TYPES.DELETED },
  };
  return map[eventName] || null;
};

/**
 * Extract userId from SCIM CloudTrail event.
 * Uses onBehalfOf element (userName/principalId no longer emitted as of July 2025).
 * @param {object} detail - CloudTrail event detail
 * @returns {string}
 */
const extractScimUserId = (detail) => {
  const onBehalfOf = detail.onBehalfOf;
  if (Array.isArray(onBehalfOf) && onBehalfOf.length > 0) {
    return onBehalfOf[0].userId || '';
  }
  if (onBehalfOf && typeof onBehalfOf === 'object' && !Array.isArray(onBehalfOf)) {
    return onBehalfOf.userId || '';
  }
  // Fallback to requestParameters
  const requestParams = detail.requestParameters || {};
  return requestParams.userId || requestParams.userName || '';
};

/**
 * Extract email from SCIM event response or request.
 * @param {object} detail
 * @returns {string|null}
 */
const extractScimEmail = (detail) => {
  const responseElements = detail.responseElements || {};
  const requestParams = detail.requestParameters || {};
  return responseElements.email
    || requestParams.email
    || responseElements.emails?.[0]?.value
    || requestParams.emails?.[0]?.value
    || null;
};

/**
 * Extract actor ID from CloudTrail event.
 * @param {object} detail
 * @returns {string}
 */
const extractCloudTrailActorId = (detail) => {
  const identity = detail.userIdentity || {};
  return identity.arn || identity.principalId || identity.userName || 'SYSTEM';
};

/**
 * Extract changed field names from request parameters.
 * @param {object} requestParams
 * @returns {string[]}
 */
const extractChangedFields = (requestParams) => {
  if (!requestParams) return [];
  const userAttributes = requestParams.userAttributes || requestParams.attributes;
  if (Array.isArray(userAttributes)) {
    return userAttributes.map((attr) => attr.name || attr.Name).filter(Boolean);
  }
  if (userAttributes && typeof userAttributes === 'object') {
    return Object.keys(userAttributes);
  }
  return [];
};

/**
 * Write audit record to DynamoDB with deduplication.
 * Uses ConditionExpression to prevent duplicate writes.
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
    // Non-critical - don't throw, audit record is already written
  }
};

// Exported for testing
export {
  isCognitoPostConfirmation,
  isEventBridgeEvent,
  handleCognitoPostConfirmation,
  handleCloudTrailEvent,
  determineCognitoSource,
  extractCognitoActorId,
  mapCognitoEventType,
  mapScimEventType,
  extractScimUserId,
  extractScimEmail,
  extractCloudTrailActorId,
  extractChangedFields,
  writeAuditRecord,
  writeEmailLookup,
  isScimDisableEvent,
  createDeletionProof,
  createDisableFollowUp,
  archiveDeletionProof,
  checkReprovisioning,
  createReprovisioningAlert,
};
