/**
 * Cryptographic utilities for evidence hashing.
 * Part of the three-layer cryptographic evidence chain (Layer 2).
 * @module shared/crypto-utils
 */

import { createHash } from 'node:crypto';

/**
 * Compute SHA-256 hex digest of arbitrary data.
 * @param {string} data - Input string to hash
 * @returns {string} Hex-encoded SHA-256 digest prefixed with "sha256:"
 */
const computeHash = (data) => {
  const hash = createHash('sha256').update(data, 'utf8').digest('hex');
  return `sha256:${hash}`;
};

/**
 * Compute evidence hash from an audit record's key fields.
 * Used for Layer 2 hash chain - each record's hash covers its identity-critical fields.
 * @param {{ userId: string, eventType: string, timestamp: string, metadata?: object }} record
 * @returns {string} Hex-encoded SHA-256 digest prefixed with "sha256:"
 */
const computeEvidenceHash = (record) => {
  const { userId, eventType, timestamp, metadata } = record;
  const metadataStr = metadata ? JSON.stringify(metadata, Object.keys(metadata).sort()) : '';
  const payload = `${userId}|${eventType}|${timestamp}|${metadataStr}`;
  return computeHash(payload);
};

/**
 * Compute deletion proof hash for compliance evidence chain.
 * Covers all fields required to prove a user was deleted at source and locally.
 * @param {string} userId
 * @param {string} sourceDeletedAt - ISO 8601 timestamp of deletion at identity source
 * @param {string} localDeletedAt - ISO 8601 timestamp of local record creation
 * @param {string} cloudTrailEventId - CloudTrail event ID for the deletion
 * @param {string} reconciliationRunId - ID of the reconciliation run that detected deletion
 * @returns {string} Hex-encoded SHA-256 digest prefixed with "sha256:"
 */
const computeDeletionProofHash = (userId, sourceDeletedAt, localDeletedAt, cloudTrailEventId, reconciliationRunId) => {
  const payload = `${userId}|${sourceDeletedAt}|${localDeletedAt}|${cloudTrailEventId}|${reconciliationRunId}`;
  return computeHash(payload);
};

export { computeHash, computeEvidenceHash, computeDeletionProofHash };
