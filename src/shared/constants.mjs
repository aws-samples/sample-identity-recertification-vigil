/**
 * Application-wide constants.
 * Event types, identity sources, entity types, DynamoDB key prefixes, and API helpers.
 * @module shared/constants
 */

/** Lifecycle event types */
const EVENT_TYPES = Object.freeze({
  CREATED: 'CREATED',
  MODIFIED: 'MODIFIED',
  DELETED: 'DELETED',
  DISABLED: 'DISABLED',
  DISABLED_AT_SOURCE: 'DISABLED_AT_SOURCE',
});

/** Identity source identifiers */
const IDENTITY_SOURCES = Object.freeze({
  COGNITO: 'COGNITO',
  JIT: 'JIT',
  IAM: 'IAM',
  IDENTITY_CENTER: 'IDENTITY_CENTER',
  SCIM: 'SCIM',
});

/** DynamoDB entity type discriminators */
const ENTITY_TYPES = Object.freeze({
  LIFECYCLE_EVENT: 'LIFECYCLE_EVENT',
  ACTIVITY: 'ACTIVITY',
  ACTIVITY_DAILY: 'ACTIVITY_DAILY',
  RECERT_ITEM: 'RECERT_ITEM',
  RECERT_DECISION: 'RECERT_DECISION',
  RECERT_CYCLE: 'RECERT_CYCLE',
  ASSIGNMENT: 'ASSIGNMENT',
  OWNER_OVERRIDE: 'OWNER_OVERRIDE',
  IC_OWNER_MAPPING: 'IC_OWNER_MAPPING',
  NOTIFICATION: 'NOTIFICATION',
  IAM_USER_SNAPSHOT: 'IAM_USER_SNAPSHOT',
  IC_USER_SNAPSHOT: 'IC_USER_SNAPSHOT',
  DELETION_PROOF: 'DELETION_PROOF',
  RECONCILIATION_RUN: 'RECONCILIATION_RUN',
  ALERT: 'ALERT',
  REVOCATION_TICKET: 'REVOCATION_TICKET',
  REVOCATION_SNAPSHOT: 'REVOCATION_SNAPSHOT',
  ACCOUNT: 'ACCOUNT',
});

/** AWS resource type identifiers for resource-centric recertification */
const RESOURCE_TYPES = Object.freeze({
  S3_BUCKET: 's3:bucket',
  EC2_INSTANCE: 'ec2:instance',
  LAMBDA_FUNCTION: 'lambda:function',
  RDS_INSTANCE: 'rds:db',
  DYNAMODB_TABLE: 'dynamodb:table',
  IAM_ROLE: 'iam:role',
  IAM_USER: 'iam:user',
  SNS_TOPIC: 'sns:topic',
  SQS_QUEUE: 'sqs:queue',
  UNKNOWN: 'unknown',
});

/** DynamoDB key prefixes - PK format: PREFIX#identifier */
const KEY_PREFIXES = Object.freeze({
  USER: 'USER#',
  TYPE: 'TYPE#',
  SOURCE: 'SOURCE#',
  EMAIL: 'EMAIL#',
  MANAGER: 'MANAGER#',
  OWNER: 'OWNER#',
  CYCLE: 'CYCLE#',
  ASSIGNMENT: 'ASSIGNMENT#',
  OVERRIDE: 'OVERRIDE#',
  IC_OWNER_MAP: 'IC_OWNER_MAP#',
  RECONCILIATION: 'RECONCILIATION#',
  STATS_DAILY: 'STATS#DAILY',
  IAM_USER: 'IAM_USER#',
  IC_USER: 'IC_USER#',
  RESOURCE: 'RESOURCE#',
  ACCOUNT: 'ACCOUNT#',
});

/** DynamoDB sort key prefixes - SK format: PREFIX#timestamp_or_id */
const SK_PREFIXES = Object.freeze({
  LIFECYCLE: 'LIFECYCLE#',
  ACTIVITY: 'ACTIVITY#',
  SYNC: 'SYNC#',
  RECERT: 'RECERT#',
  RECERT_ITEM: 'RECERT_ITEM#',
  SNAPSHOT: 'SNAPSHOT#',
  REVOCATION_SNAPSHOT: 'REVOCATION_SNAPSHOT#',
  RUN: 'RUN#',
  SUMMARY: 'SUMMARY',
  DELETION_PROOF: 'DELETION_PROOF#',
});

/**
 * Build a successful API response.
 * @param {number} statusCode - HTTP status code
 * @param {*} data - Response payload
 * @returns {{ statusCode: number, headers: object, body: string }}
 */
const successResponse = (statusCode, data) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify({ success: true, data }),
});

/**
 * Build an error API response.
 * @param {number} statusCode - HTTP status code
 * @param {string} error - Error message (safe for external consumers)
 * @returns {{ statusCode: number, headers: object, body: string }}
 */
const errorResponse = (statusCode, error) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify({ success: false, error }),
});

export {
  EVENT_TYPES,
  IDENTITY_SOURCES,
  ENTITY_TYPES,
  KEY_PREFIXES,
  SK_PREFIXES,
  RESOURCE_TYPES,
  successResponse,
  errorResponse,
};
