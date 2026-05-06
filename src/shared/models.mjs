/**
 * DynamoDB record builder functions.
 * Each builder returns a complete DynamoDB item with PK/SK/GSI keys,
 * timestamps (UTC + IST + epoch), and entityType.
 * @module shared/models
 */

import { toIST, toEpoch, toISOString } from './time-utils.mjs';
import { computeEvidenceHash } from './crypto-utils.mjs';
import {
  ENTITY_TYPES,
  KEY_PREFIXES,
  SK_PREFIXES,
} from './constants.mjs';

/**
 * @typedef {Object} AuditRecord
 * @property {string} PK - USER#{userId}
 * @property {string} SK - LIFECYCLE#{timestamp}
 * @property {string} GSI1PK - TYPE#{eventType}
 * @property {string} GSI1SK - {timestamp}
 * @property {string} GSI2PK - SOURCE#{source}
 * @property {string} GSI2SK - {userId}
 * @property {string} entityType - LIFECYCLE_EVENT
 * @property {string} userId
 * @property {string} eventType
 * @property {string} source
 * @property {string} [email]
 * @property {string} [actorId]
 * @property {object|null} [previousState]
 * @property {object|null} [newState]
 * @property {string[]} [changedFields]
 * @property {object} [metadata]
 * @property {string} [previousHash] - SHA-256 hash of prior record in chain
 * @property {string} [evidenceHash]
 * @property {string} [evidenceS3Key]
 * @property {string} createdAt - UTC ISO 8601
 * @property {number} createdAtEpoch - Milliseconds since epoch
 * @property {string} createdAtIST - IST ISO 8601
 */

/**
 * Validate required fields for an audit record.
 * @param {{ userId: string, eventType: string, source: string }} params
 * @throws {Error} If required fields are missing
 */
const validateAuditParams = ({ userId, eventType, source }) => {
  if (!userId) throw new Error('userId is required');
  if (!eventType) throw new Error('eventType is required');
  if (!source) throw new Error('source is required');
};

/**
 * Build timestamp fields for a DynamoDB item.
 * @param {Date|string} [date] - Optional date; defaults to now
 * @returns {{ createdAt: string, createdAtEpoch: number, createdAtIST: string }}
 */
const buildTimestamps = (date) => {
  const d = date ? new Date(date) : new Date();
  const createdAt = toISOString(d);
  return {
    createdAt,
    createdAtEpoch: toEpoch(d),
    createdAtIST: toIST(d),
  };
};

/**
 * Build a complete lifecycle audit record for DynamoDB.
 * @param {Object} params
 * @param {string} params.userId - Cognito sub or identity source user ID
 * @param {string} params.eventType - One of EVENT_TYPES
 * @param {string} params.source - One of IDENTITY_SOURCES
 * @param {string} [params.email]
 * @param {string} [params.actorId] - Who performed the action
 * @param {object|null} [params.previousState]
 * @param {object|null} [params.newState]
 * @param {string[]} [params.changedFields]
 * @param {object} [params.metadata] - Additional context (CloudTrail ID, SCIM correlation, etc.)
 * @param {string} [params.previousHash] - SHA-256 hash of prior record for chain continuity
 * @param {Date|string} [params.timestamp] - Event timestamp; defaults to now
 * @returns {AuditRecord}
 */
const buildAuditRecord = ({
  userId,
  eventType,
  source,
  email,
  actorId,
  previousState = null,
  newState = null,
  changedFields = [],
  metadata = {},
  previousHash,
  timestamp,
}) => {
  validateAuditParams({ userId, eventType, source });

  const timestamps = buildTimestamps(timestamp);

  const record = {
    PK: `${KEY_PREFIXES.USER}${userId}`,
    SK: `${SK_PREFIXES.LIFECYCLE}${timestamps.createdAt}`,
    GSI1PK: `${KEY_PREFIXES.TYPE}${eventType}`,
    GSI1SK: timestamps.createdAt,
    GSI2PK: `${KEY_PREFIXES.SOURCE}${source}`,
    GSI2SK: userId,
    entityType: ENTITY_TYPES.LIFECYCLE_EVENT,
    userId,
    eventType,
    source,
    actorId: actorId || 'SYSTEM',
    previousState,
    newState,
    changedFields,
    metadata,
    ...timestamps,
  };

  if (email) {
    record.email = email;
  }

  if (previousHash) {
    record.previousHash = previousHash;
  }

  record.evidenceHash = computeEvidenceHash({
    userId,
    eventType,
    timestamp: timestamps.createdAt,
    metadata,
  });

  return record;
};

/**
 * Build an email-to-userId lookup record for search.
 * PK: EMAIL#{email}, SK: USER#{userId}
 * @param {string} email
 * @param {string} userId
 * @returns {object} DynamoDB item
 */
const buildEmailLookupRecord = (email, userId) => {
  if (!email) throw new Error('email is required');
  if (!userId) throw new Error('userId is required');

  const timestamps = buildTimestamps();

  return {
    PK: `${KEY_PREFIXES.EMAIL}${email.toLowerCase()}`,
    SK: `${KEY_PREFIXES.USER}${userId}`,
    entityType: 'EMAIL_LOOKUP',
    email: email.toLowerCase(),
    userId,
    ...timestamps,
  };
};

/**
 * Build an activity record for user login/action tracking.
 * PK: USER#{userId}, SK: ACTIVITY#{date}#{timestamp}
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.activityType - e.g. "LOGIN", "API_CALL"
 * @param {string} [params.ipAddress]
 * @param {string} [params.userAgent]
 * @param {object} [params.metadata]
 * @param {Date|string} [params.timestamp]
 * @returns {object} DynamoDB item
 */
const buildActivityRecord = ({
  userId,
  activityType,
  ipAddress,
  userAgent,
  metadata = {},
  timestamp,
}) => {
  if (!userId) throw new Error('userId is required');
  if (!activityType) throw new Error('activityType is required');

  const timestamps = buildTimestamps(timestamp);
  const dateStr = timestamps.createdAt.slice(0, 10); // YYYY-MM-DD

  return {
    PK: `${KEY_PREFIXES.USER}${userId}`,
    SK: `${SK_PREFIXES.ACTIVITY}${dateStr}#${timestamps.createdAt}`,
    entityType: ENTITY_TYPES.ACTIVITY,
    userId,
    activityType,
    ipAddress: ipAddress || null,
    userAgent: userAgent || null,
    metadata,
    ...timestamps,
  };
};

/**
 * Build a daily activity stats record.
 * PK: USER#{userId}, SK: ACTIVITY_DAILY#{date}
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.date - YYYY-MM-DD
 * @param {number} [params.loginCount]
 * @param {number} [params.failedLoginCount]
 * @param {string[]} [params.uniqueIPs]
 * @param {string} [params.lastLoginAt]
 * @param {object} [params.metadata]
 * @returns {object} DynamoDB item
 */
const buildDailyStatsRecord = ({
  userId,
  date,
  loginCount = 0,
  failedLoginCount = 0,
  uniqueIPs = [],
  lastLoginAt,
  metadata = {},
}) => {
  if (!userId) throw new Error('userId is required');
  if (!date) throw new Error('date is required');

  const timestamps = buildTimestamps();

  return {
    PK: `${KEY_PREFIXES.USER}${userId}`,
    SK: `ACTIVITY_DAILY#${date}`,
    entityType: ENTITY_TYPES.ACTIVITY_DAILY,
    userId,
    date,
    loginCount,
    failedLoginCount,
    uniqueIPs,
    lastLoginAt: lastLoginAt || null,
    metadata,
    ...timestamps,
  };
};

/**
 * Validate that a value is a non-empty string.
 * @param {*} value
 * @param {string} fieldName
 * @throws {Error} If value is not a non-empty string
 */
const validateRequiredString = (value, fieldName) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
};

/**
 * Validate that a value is one of the allowed values.
 * @param {string} value
 * @param {object} allowedMap - Object whose values are the allowed strings
 * @param {string} fieldName
 * @throws {Error} If value is not in the allowed set
 */
const validateEnum = (value, allowedMap, fieldName) => {
  const allowed = Object.values(allowedMap);
  if (!allowed.includes(value)) {
    throw new Error(`${fieldName} must be one of: ${allowed.join(', ')}`);
  }
};

export {
  buildAuditRecord,
  buildEmailLookupRecord,
  buildActivityRecord,
  buildDailyStatsRecord,
  buildTimestamps,
  validateAuditParams,
  validateRequiredString,
  validateEnum,
};
