/**
 * Evidence Archiver Lambda - triggered by DynamoDB Streams.
 * Archives lifecycle audit records to S3 with Object Lock and computes SHA-256 evidence hashes.
 * Only processes INSERT events for LIFECYCLE_EVENT entity types.
 * @module functions/evidence-archiver
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ddbClient, TABLE_NAME } from '../../shared/dynamo-client.mjs';
import { computeHash } from '../../shared/crypto-utils.mjs';
import { ENTITY_TYPES } from '../../shared/constants.mjs';
import { toISOString } from '../../shared/time-utils.mjs';

const FUNCTION_NAME = 'evidence-archiver';
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET || 'evidence-bucket';
const METADATA_OVERFLOW_THRESHOLD = 300 * 1024; // 300KB
const RETENTION_YEARS = 8;

const s3Client = new S3Client({});

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
 * Main handler - processes DynamoDB Streams records.
 * @param {object} event - DynamoDB Streams event
 * @returns {Promise<void>}
 */
export const handler = async (event) => {
  const records = event.Records || [];
  logInfo('STREAM_BATCH_RECEIVED', { recordCount: records.length });

  for (const record of records) {
    try {
      await processStreamRecord(record);
    } catch (error) {
      logError('RECORD_PROCESSING_ERROR', error.message);
    }
  }
};

/**
 * Process a single DynamoDB Streams record.
 * Only handles INSERT events for LIFECYCLE_EVENT entity types.
 * @param {object} record - DynamoDB Streams record
 */
const processStreamRecord = async (record) => {
  if (record.eventName !== 'INSERT') {
    return;
  }

  const newImage = record.dynamodb?.NewImage;
  if (!newImage) {
    return;
  }

  const item = unmarshall(newImage);

  if (item.entityType !== ENTITY_TYPES.LIFECYCLE_EVENT) {
    return;
  }

  logInfo('PROCESSING_LIFECYCLE_EVENT', {
    userId: item.userId,
    eventType: item.eventType,
  });

  await archiveToS3(item);
};

/**
 * Archive an audit record to S3 and update DynamoDB with evidence hash and S3 key.
 * @param {object} item - Unmarshalled DynamoDB item
 */
const archiveToS3 = async (item) => {
  const s3Key = buildS3Key(item);
  const { body, overflowKey } = await buildArchiveBody(item, s3Key);
  const bodyString = JSON.stringify(body, null, 2);
  const evidenceHash = computeHash(bodyString);

  await putS3Object(s3Key, bodyString);

  if (overflowKey) {
    logInfo('METADATA_OVERFLOW_ARCHIVED', { s3Key: overflowKey, userId: item.userId });
  }

  await updateDynamoDBEvidence(item.PK, item.SK, evidenceHash, s3Key);

  logInfo('EVIDENCE_ARCHIVED', {
    userId: item.userId,
    eventType: item.eventType,
    s3Key,
    evidenceHash,
  });
};

/**
 * Build S3 key for evidence archival.
 * Format: evidence/{year}/{month}/{userId}/{eventType}_{timestamp}.json
 * @param {object} item - Audit record
 * @returns {string} S3 key
 */
const buildS3Key = (item) => {
  const timestamp = item.createdAt || toISOString(new Date());
  const date = new Date(timestamp);
  const year = date.getUTCFullYear().toString();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const safeTimestamp = timestamp.replace(/[:.]/g, '-');

  return `evidence/${year}/${month}/${item.userId}/${item.eventType}_${safeTimestamp}.json`;
};

/**
 * Build the archive body, handling metadata overflow.
 * If serialized record > 300KB, splits metadata to a separate S3 object.
 * @param {object} item - Audit record
 * @param {string} s3Key - Main evidence S3 key
 * @returns {Promise<{ body: object, overflowKey: string|null }>}
 */
const buildArchiveBody = async (item, s3Key) => {
  const body = { ...item };
  const serialized = JSON.stringify(body, null, 2);

  if (Buffer.byteLength(serialized, 'utf8') <= METADATA_OVERFLOW_THRESHOLD) {
    return { body, overflowKey: null };
  }

  const overflowKey = s3Key.replace('.json', '_metadata.json');
  const metadataContent = JSON.stringify(item.metadata, null, 2);

  await putS3Object(overflowKey, metadataContent);

  body.metadata = { _overflow: true, _overflowS3Key: overflowKey };
  return { body, overflowKey };
};

/**
 * Put an object to S3 with Object Lock retention and SSE-S3 encryption.
 * @param {string} key - S3 object key
 * @param {string} content - Object content
 */
const putS3Object = async (key, content) => {
  const retainUntilDate = new Date();
  retainUntilDate.setFullYear(retainUntilDate.getFullYear() + RETENTION_YEARS);

  await s3Client.send(new PutObjectCommand({
    Bucket: EVIDENCE_BUCKET,
    Key: key,
    Body: content,
    ContentType: 'application/json',
    ServerSideEncryption: 'AES256',
    ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate: retainUntilDate,
  }));
};

/**
 * Update DynamoDB record with evidence hash and S3 key.
 * Only updates evidenceHash and evidenceS3Key fields, preserving immutability of other fields.
 * @param {string} pk - Partition key
 * @param {string} sk - Sort key
 * @param {string} evidenceHash - SHA-256 hash of archived content
 * @param {string} evidenceS3Key - S3 key where evidence is stored
 */
const updateDynamoDBEvidence = async (pk, sk, evidenceHash, evidenceS3Key) => {
  await ddbClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: pk, SK: sk },
    UpdateExpression: 'SET evidenceHash = :hash, evidenceS3Key = :s3Key',
    ExpressionAttributeValues: {
      ':hash': evidenceHash,
      ':s3Key': evidenceS3Key,
    },
  }));
};

// Exported for testing
export {
  processStreamRecord,
  archiveToS3,
  buildS3Key,
  buildArchiveBody,
  putS3Object,
  updateDynamoDBEvidence,
  METADATA_OVERFLOW_THRESHOLD,
};
