/**
 * Audit Query Lambda - handles auditor-facing API endpoints.
 * Routes:
 *   GET /audit/users/{userId}/timeline - lifecycle event timeline
 *   GET /audit/users/{userId}/deletion-proof - deletion evidence chain
 *   GET /audit/export - CSV/PDF export of audit events
 *   GET /search/users - universal user search across identity sources
 * @module functions/audit-query
 */

import { QueryCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddbClient, TABLE_NAME } from '../../shared/dynamo-client.mjs';
import { toIST, toISOString, toEpoch } from '../../shared/time-utils.mjs';
import {
  KEY_PREFIXES,
  SK_PREFIXES,
  ENTITY_TYPES,
  EVENT_TYPES,
  successResponse,
  errorResponse,
} from '../../shared/constants.mjs';

const FUNCTION_NAME = 'audit-query';
const DEFAULT_LIMIT = 50;

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
 * Main handler - routes by resource path and HTTP method.
 * @param {object} event - API Gateway proxy event
 * @returns {{ statusCode: number, headers: object, body: string }}
 */
export const handler = async (event) => {
  try {
    const route = resolveRoute(event);
    if (!route) {
      return errorResponse(404, 'Route not found');
    }
    return await route(event);
  } catch (error) {
    logError('HANDLER_ERROR', error.message);
    return errorResponse(500, 'Internal server error');
  }
};

/**
 * Resolve the handler function for the incoming request.
 * @param {object} event - API Gateway event
 * @returns {Function|null}
 */
const resolveRoute = (event) => {
  const resource = event.resource || '';
  const method = (event.httpMethod || '').toUpperCase();

  if (method !== 'GET') return null;

  const routes = {
    '/audit/users/{userId}/timeline': handleTimeline,
    '/audit/users/{userId}/deletion-proof': handleDeletionProof,
    '/audit/export': handleExport,
    '/search/users': handleSearch,
    '/users/{userId}/detail': handleUserDetail,
    '/dashboard/summary': handleDashboardSummary,
    '/dashboard/events/timeline': handleDashboardTimeline,
    '/dashboard/users/distribution': handleDashboardDistribution,
  };

  return routes[resource] || null;
};

// Timeline endpoint (4.2) 

/**
 * GET /audit/users/{userId}/timeline
 * Query lifecycle events sorted chronologically with pagination.
 * @param {object} event
 * @returns {object} API response
 */
const handleTimeline = async (event) => {
  const userId = event.pathParameters?.userId;
  if (!userId) {
    return errorResponse(400, 'userId is required');
  }

  const queryParams = event.queryStringParameters || {};
  const limit = parseLimit(queryParams.limit);
  const scanForward = queryParams.order !== 'desc';
  const lastKey = decodeLastKey(queryParams.lastKey);

  const params = buildTimelineQuery(userId, limit, scanForward, lastKey);
  const result = await ddbClient.send(new QueryCommand(params));

  const items = (result.Items || []).map(formatTimelineItem);
  const nextKey = result.LastEvaluatedKey
    ? encodeLastKey(result.LastEvaluatedKey)
    : null;

  logInfo('TIMELINE_QUERY', { userId, count: items.length });

  return successResponse(200, {
    userId,
    events: items,
    count: items.length,
    nextKey,
  });
};

/**
 * Build DynamoDB query params for timeline.
 * @param {string} userId
 * @param {number} limit
 * @param {boolean} scanForward
 * @param {object|null} lastKey
 * @returns {object}
 */
const buildTimelineQuery = (userId, limit, scanForward, lastKey) => {
  const params = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.USER}${userId}`,
      ':skPrefix': SK_PREFIXES.LIFECYCLE,
    },
    ScanIndexForward: scanForward,
    Limit: limit,
  };

  if (lastKey) {
    params.ExclusiveStartKey = lastKey;
  }

  return params;
};

/**
 * Format a timeline item with both UTC and IST timestamps.
 * @param {object} item - DynamoDB item
 * @returns {object}
 */
const formatTimelineItem = (item) => ({
  userId: item.userId,
  eventType: item.eventType,
  source: item.source,
  actorId: item.actorId,
  email: item.email || null,
  previousState: item.previousState || null,
  newState: item.newState || null,
  changedFields: item.changedFields || [],
  metadata: item.metadata || {},
  evidenceHash: item.evidenceHash || null,
  evidenceS3Key: item.evidenceS3Key || null,
  timestamp_utc: item.createdAt,
  timestamp_ist: item.createdAtIST,
  createdAtEpoch: item.createdAtEpoch,
});

// Deletion proof endpoint (4.3) 

/**
 * GET /audit/users/{userId}/deletion-proof
 * Assemble deletion evidence chain with timestamps and S3 references.
 * @param {object} event
 * @returns {object} API response
 */
const handleDeletionProof = async (event) => {
  const userId = event.pathParameters?.userId;
  if (!userId) {
    return errorResponse(400, 'userId is required');
  }

  const [lifecycleEvents, deletionProofs] = await Promise.all([
    queryDeletionLifecycleEvents(userId),
    queryDeletionProofRecords(userId),
  ]);

  const evidenceChain = assembleEvidenceChain(userId, lifecycleEvents, deletionProofs);

  logInfo('DELETION_PROOF_QUERY', { userId, eventCount: lifecycleEvents.length, proofCount: deletionProofs.length });

  return successResponse(200, {
    userId,
    evidenceChain,
    totalEvents: lifecycleEvents.length,
    totalProofs: deletionProofs.length,
  });
};

/**
 * Query deletion-related lifecycle events for a user.
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
const queryDeletionLifecycleEvents = async (userId) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.USER}${userId}`,
      ':skPrefix': SK_PREFIXES.LIFECYCLE,
    },
    ScanIndexForward: true,
  }));

  return (result.Items || []).filter((item) =>
    item.eventType === EVENT_TYPES.DELETED
    || item.eventType === EVENT_TYPES.DISABLED
    || item.eventType === EVENT_TYPES.DISABLED_AT_SOURCE
  );
};

/**
 * Query DELETION_PROOF records for a user.
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
const queryDeletionProofRecords = async (userId) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.USER}${userId}`,
      ':skPrefix': SK_PREFIXES.DELETION_PROOF,
    },
    ScanIndexForward: true,
  }));

  return result.Items || [];
};

/**
 * Assemble evidence chain from lifecycle events and deletion proofs.
 * @param {string} userId
 * @param {object[]} lifecycleEvents
 * @param {object[]} deletionProofs
 * @returns {object}
 */
const assembleEvidenceChain = (userId, lifecycleEvents, deletionProofs) => {
  const deletionEvents = lifecycleEvents.map((item) => ({
    type: 'LIFECYCLE_EVENT',
    eventType: item.eventType,
    source: item.source,
    actorId: item.actorId,
    timestamp_utc: item.createdAt,
    timestamp_ist: item.createdAtIST,
    evidenceHash: item.evidenceHash || null,
    evidenceS3Key: item.evidenceS3Key || null,
    metadata: item.metadata || {},
  }));

  const proofs = deletionProofs.map((item) => ({
    type: 'DELETION_PROOF',
    proofHash: item.proofHash || item.evidenceHash || null,
    sourceDeletedAt: item.sourceDeletedAt || null,
    localDeletedAt: item.localDeletedAt || item.createdAt,
    cloudTrailEventId: item.cloudTrailEventId || item.metadata?.cloudTrailEventId || null,
    reconciliationRunId: item.reconciliationRunId || null,
    evidenceS3Key: item.evidenceS3Key || null,
    timestamp_utc: item.createdAt,
    timestamp_ist: item.createdAtIST,
  }));

  return {
    userId,
    deletionEvents,
    deletionProofs: proofs,
    chainComplete: deletionEvents.length > 0 && proofs.length > 0,
    generatedAt_utc: toISOString(new Date()),
    generatedAt_ist: toIST(new Date()),
  };
};

// Export endpoint (4.4 + 4.5) 

/**
 * GET /audit/export
 * Export audit events as CSV or PDF.
 * @param {object} event
 * @returns {object} API response
 */
const handleExport = async (event) => {
  const queryParams = event.queryStringParameters || {};
  const { startDate, endDate, format, eventType } = queryParams;

  if (!startDate || !endDate) {
    return errorResponse(400, 'startDate and endDate are required');
  }

  if (!isValidDateRange(startDate, endDate)) {
    return errorResponse(400, 'Invalid date range: startDate must be before endDate');
  }

  const items = await queryExportData(startDate, endDate, eventType);

  if (format === 'pdf') {
    return buildPdfResponse(items, startDate, endDate);
  }

  // Default to CSV
  return buildCsvResponse(items, startDate, endDate);
};

/**
 * Query audit events for export using GSI1.
 * If eventType is specified, query that specific type. Otherwise query all event types.
 * @param {string} startDate
 * @param {string} endDate
 * @param {string} [eventType]
 * @returns {Promise<object[]>}
 */
const queryExportData = async (startDate, endDate, eventType) => {
  const eventTypes = eventType
    ? [eventType]
    : Object.values(EVENT_TYPES);

  const queries = eventTypes.map((type) => queryGSI1ByType(type, startDate, endDate));
  const results = await Promise.all(queries);

  const allItems = results.flat();
  allItems.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return allItems;
};

/**
 * Query GSI1 for a specific event type within a date range.
 * @param {string} eventType
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Promise<object[]>}
 */
const queryGSI1ByType = async (eventType, startDate, endDate) => {
  const items = [];
  let lastKey = null;

  do {
    const params = {
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :gsi1pk AND GSI1SK BETWEEN :start AND :end',
      ExpressionAttributeValues: {
        ':gsi1pk': `${KEY_PREFIXES.TYPE}${eventType}`,
        ':start': startDate,
        ':end': endDate,
      },
      ScanIndexForward: true,
    };

    if (lastKey) {
      params.ExclusiveStartKey = lastKey;
    }

    const result = await ddbClient.send(new QueryCommand(params));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  return items;
};

// CSV generation (4.4) 

const CSV_COLUMNS = [
  'userId',
  'eventType',
  'timestamp_utc',
  'timestamp_ist',
  'source',
  'actorId',
  'changedFields',
  'details',
];

/**
 * Build CSV export response with base64-encoded body.
 * @param {object[]} items
 * @param {string} startDate
 * @param {string} endDate
 * @returns {object} API Gateway response
 */
const buildCsvResponse = (items, startDate, endDate) => {
  const csv = generateCsv(items);
  const filename = `audit-export_${startDate}_${endDate}.csv`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*',
    },
    body: Buffer.from(csv, 'utf-8').toString('base64'),
    isBase64Encoded: true,
  };
};

/**
 * Generate CSV string from audit items.
 * @param {object[]} items
 * @returns {string}
 */
const generateCsv = (items) => {
  const header = CSV_COLUMNS.join(',');
  const rows = items.map(formatCsvRow);
  return [header, ...rows].join('\n');
};

/**
 * Format a single audit item as a CSV row.
 * @param {object} item
 * @returns {string}
 */
const formatCsvRow = (item) => {
  const values = [
    escapeCsvField(item.userId || ''),
    escapeCsvField(item.eventType || ''),
    escapeCsvField(item.createdAt || ''),
    escapeCsvField(item.createdAtIST || ''),
    escapeCsvField(item.source || ''),
    escapeCsvField(item.actorId || ''),
    escapeCsvField((item.changedFields || []).join('; ')),
    escapeCsvField(summarizeDetails(item)),
  ];
  return values.join(',');
};

/**
 * Escape a CSV field value (wrap in quotes if contains comma, quote, or newline).
 * @param {string} value
 * @returns {string}
 */
const escapeCsvField = (value) => {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

/**
 * Summarize item details for CSV export.
 * @param {object} item
 * @returns {string}
 */
const summarizeDetails = (item) => {
  const parts = [];
  if (item.email) parts.push(`email: ${item.email}`);
  if (item.metadata?.cloudTrailEventId) {
    parts.push(`cloudTrailId: ${item.metadata.cloudTrailEventId}`);
  }
  if (item.evidenceS3Key) parts.push(`evidence: ${item.evidenceS3Key}`);
  return parts.join('; ');
};

// PDF generation (4.5) 

/**
 * Build PDF export response.
 * ASSUMPTION: Uses simple text-based PDF generation without external libraries.
 * Generates a minimal valid PDF structure manually.
 * @param {object[]} items
 * @param {string} startDate
 * @param {string} endDate
 * @returns {object} API Gateway response
 */
const buildPdfResponse = (items, startDate, endDate) => {
  const pdfBytes = generatePdf(items, startDate, endDate);
  const filename = `audit-export_${startDate}_${endDate}.pdf`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*',
    },
    body: Buffer.from(pdfBytes).toString('base64'),
    isBase64Encoded: true,
  };
};

/**
 * Generate a minimal valid PDF document with audit data.
 * Uses raw PDF syntax - no external libraries required.
 * @param {object[]} items
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Buffer}
 */
const generatePdf = (items, startDate, endDate) => {
  const now = new Date();
  const generatedAt = toISOString(now);
  const generatedAtIST = toIST(now);
  const totalPages = Math.max(1, Math.ceil(items.length / 30));

  const lines = buildPdfContentLines(items, startDate, endDate, generatedAt, generatedAtIST, totalPages);
  const contentStream = lines.join('\n');

  return buildRawPdf(contentStream, startDate, endDate, generatedAt);
};

/**
 * Build text content lines for the PDF body.
 * @param {object[]} items
 * @param {string} startDate
 * @param {string} endDate
 * @param {string} generatedAt
 * @param {string} generatedAtIST
 * @param {number} totalPages
 * @returns {string[]}
 */
const buildPdfContentLines = (items, startDate, endDate, generatedAt, generatedAtIST, totalPages) => {
  const lines = [];
  let yPos = 750;

  // Header
  lines.push('BT');
  lines.push('/F1 16 Tf');
  lines.push(`50 ${yPos} Td`);
  lines.push('(Identity Governance - Audit Export Report) Tj');
  yPos -= 25;

  lines.push('/F1 10 Tf');
  lines.push(`50 ${yPos} Td`);
  lines.push(`(Date Range: ${startDate} to ${endDate}) Tj`);
  yPos -= 15;

  lines.push(`50 ${yPos} Td`);
  lines.push(`(Generated: ${generatedAtIST} IST) Tj`);
  yPos -= 15;

  lines.push(`50 ${yPos} Td`);
  lines.push(`(Total Records: ${items.length} | Pages: ${totalPages}) Tj`);
  yPos -= 25;

  // Column headers
  lines.push('/F1 9 Tf');
  lines.push(`50 ${yPos} Td`);
  lines.push('(UserId | EventType | Timestamp UTC | Source | ActorId) Tj');
  yPos -= 5;

  lines.push(`50 ${yPos} Td`);
  lines.push('(------------------------------------------------------------------------) Tj');
  yPos -= 15;

  // Data rows
  lines.push('/F1 8 Tf');
  for (const item of items) {
    if (yPos < 50) {
      yPos = 750;
      lines.push(`50 ${yPos} Td`);
      lines.push('(--- continued ---) Tj');
      yPos -= 20;
    }

    const row = pdfEscape(
      `${truncateStr(item.userId, 20)} | ${item.eventType || ''} | ${item.createdAt || ''} | ${item.source || ''} | ${truncateStr(item.actorId, 20)}`
    );
    lines.push(`50 ${yPos} Td`);
    lines.push(`(${row}) Tj`);
    yPos -= 12;
  }

  // Footer
  yPos = 30;
  lines.push('/F1 8 Tf');
  lines.push(`50 ${yPos} Td`);
  lines.push(`(Generated: ${generatedAt} | Identity Governance Solution | Page 1 of ${totalPages}) Tj`);

  lines.push('ET');
  return lines;
};

/**
 * Build a minimal valid PDF file from content stream.
 * @param {string} contentStream
 * @param {string} startDate
 * @param {string} endDate
 * @param {string} generatedAt
 * @returns {Buffer}
 */
const buildRawPdf = (contentStream, startDate, endDate, generatedAt) => {
  const objects = [];
  const offsets = [];

  // Object 1: Catalog
  offsets.push(null); // placeholder
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // Object 2: Pages
  objects.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  // Object 3: Page
  objects.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n');

  // Object 4: Content stream
  const streamBytes = Buffer.from(contentStream, 'utf-8');
  objects.push(`4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`);

  // Object 5: Font
  objects.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  // Build PDF
  let pdf = '%PDF-1.4\n';
  const actualOffsets = [];

  for (let i = 0; i < objects.length; i++) {
    actualOffsets.push(Buffer.byteLength(pdf, 'utf-8'));
    pdf += objects[i];
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf-8');
  pdf += 'xref\n';
  pdf += `0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of actualOffsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }

  pdf += 'trailer\n';
  pdf += `<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += 'startxref\n';
  pdf += `${xrefOffset}\n`;
  pdf += '%%EOF\n';

  return Buffer.from(pdf, 'utf-8');
};

/**
 * Escape special PDF text characters.
 * @param {string} str
 * @returns {string}
 */
const pdfEscape = (str) => {
  return str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
};

/**
 * Truncate a string to maxLen characters.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
const truncateStr = (str, maxLen) => {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 2) + '..' : str;
};

// User search endpoint (5.1–5.4) 

const SEARCH_DEFAULT_LIMIT = 20;

/**
 * GET /search/users?q={searchTerm}&source={identitySource}&status={status}&limit={limit}&lastKey={lastEvaluatedKey}
 * Universal user search across DynamoDB email index and identity sources.
 * @param {object} event
 * @returns {object} API response
 */
const handleSearch = async (event) => {
  const queryParams = event.queryStringParameters || {};
  const { q: searchTerm, source, status, limit: limitStr, lastKey: lastKeyStr } = queryParams;

  if (!searchTerm || searchTerm.trim().length === 0) {
    return errorResponse(400, 'Search term (q) is required');
  }

  const limit = parseSearchLimit(limitStr);
  const lastKey = decodeLastKey(lastKeyStr);

  const rawResults = await executeSearch(searchTerm.trim(), limit, lastKey);
  const filtered = applyFilters(rawResults.items, source, status);
  const enriched = await enrichResults(filtered);

  logInfo('USER_SEARCH', { searchTerm, source, status, count: enriched.length });

  return successResponse(200, {
    results: enriched,
    count: enriched.length,
    nextKey: rawResults.nextKey,
  });
};

/**
 * Parse search limit with lower default than timeline.
 * @param {string|undefined} limitStr
 * @returns {number}
 */
const parseSearchLimit = (limitStr) => {
  if (!limitStr) return SEARCH_DEFAULT_LIMIT;
  const parsed = parseInt(limitStr, 10);
  if (isNaN(parsed) || parsed < 1) return SEARCH_DEFAULT_LIMIT;
  return Math.min(parsed, 100);
};

/**
 * Execute search: try userId exact match first, then userId prefix via GSI2,
 * then email prefix search, then broad text search across lifecycle events.
 * @param {string} searchTerm
 * @param {number} limit
 * @param {object|null} lastKey
 * @returns {Promise<{ items: object[], nextKey: string|null }>}
 */
const executeSearch = async (searchTerm, limit, lastKey) => {
  // Try exact userId match first
  const userIdResults = await searchByUserId(searchTerm);
  if (userIdResults.length > 0) {
    return { items: userIdResults, nextKey: null };
  }

  // Try userId prefix search via GSI2 (fan out across all identity sources)
  const prefixResults = await searchByUserIdPrefix(searchTerm, limit);
  if (prefixResults.length > 0) {
    return { items: prefixResults, nextKey: null };
  }

  // Email exact match via EMAIL# PK pattern
  const emailResults = await searchByEmailPrefix(searchTerm.toLowerCase(), limit, lastKey);
  if (emailResults.items.length > 0) {
    return emailResults;
  }

  // Broad text search - scan CREATED events and filter by email/name/userId containing term
  const broadResults = await searchBroadText(searchTerm.toLowerCase(), limit);
  return { items: broadResults, nextKey: null };
};

/**
 * Search by exact userId - query USER#{userId} for LIFECYCLE# records.
 * Returns the user's latest lifecycle record as a search result.
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
const searchByUserId = async (userId) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.USER}${userId}`,
      ':skPrefix': SK_PREFIXES.LIFECYCLE,
    },
    ScanIndexForward: false,
    Limit: 1,
  }));

  const item = result.Items?.[0];
  if (!item) return [];

  return [formatSearchResult(item)];
};

/**
 * Search by userId prefix - fan out across all identity sources via GSI2.
 * GSI2PK = SOURCE#{source}, GSI2SK = userId. Uses begins_with on SK.
 * @param {string} prefix - userId prefix to search
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
const searchByUserIdPrefix = async (prefix, limit) => {
  const sources = ['COGNITO', 'JIT', 'IAM', 'IDENTITY_CENTER'];
  const queries = sources.map((source) =>
    ddbClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `SOURCE#${source}`,
        ':prefix': prefix,
      },
      Limit: limit,
    }))
  );

  const results = await Promise.all(queries);
  const allItems = results.flatMap((r) => r.Items || []);

  // Deduplicate by userId and format
  const seen = new Set();
  const formatted = [];
  for (const item of allItems) {
    const userId = item.userId || item.GSI2SK;
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    formatted.push(formatSearchResult(item));
  }

  return formatted.slice(0, limit);
};

/**
 * Broad text search - query GSI1 for CREATED events and filter by email/name/userId
 * containing the search term. Acceptable for MVP with < 5000 users.
 * @param {string} term - Lowercased search term
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
const searchBroadText = async (term, limit) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.TYPE}CREATED`,
    },
    ScanIndexForward: false,
    Limit: 200,
  }));

  const items = result.Items || [];
  const matches = items.filter((item) => {
    const email = (item.email || '').toLowerCase();
    const name = (item.newState?.name || item.newState?.userName || '').toLowerCase();
    const userId = (item.userId || '').toLowerCase();
    return email.includes(term) || name.includes(term) || userId.includes(term);
  });

  // Deduplicate by userId
  const seen = new Set();
  const results = [];
  for (const item of matches) {
    if (!item.userId || seen.has(item.userId)) continue;
    seen.add(item.userId);
    results.push(formatSearchResult(item));
  }

  return results.slice(0, limit);
};

/**
 * Search by email prefix - query EMAIL#{searchTerm} with begins_with.
 * @param {string} emailPrefix - Lowercased email prefix
 * @param {number} limit
 * @param {object|null} lastKey
 * @returns {Promise<{ items: object[], nextKey: string|null }>}
 */
const searchByEmailPrefix = async (emailPrefix, limit, lastKey) => {
  const params = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.EMAIL}${emailPrefix}`,
    },
    Limit: limit,
  };

  if (lastKey) {
    params.ExclusiveStartKey = lastKey;
  }

  // First try exact email match
  const exactResult = await ddbClient.send(new QueryCommand(params));
  const exactItems = exactResult.Items || [];

  if (exactItems.length > 0) {
    const users = await resolveEmailLookups(exactItems);
    const nextKey = exactResult.LastEvaluatedKey
      ? encodeLastKey(exactResult.LastEvaluatedKey)
      : null;
    return { items: users, nextKey };
  }

  // Try prefix scan - query all EMAIL# keys that begin with the search term
  const prefixResults = await scanEmailPrefix(emailPrefix, limit);
  return prefixResults;
};

/**
 * Scan for EMAIL# records matching a prefix using begins_with on PK via GSI or scan.
 * ASSUMPTION: For MVP, we query the exact email PK. Full prefix search across
 * multiple EMAIL# PKs would require a GSI or scan. For now, returns empty if
 * exact email PK has no results.
 * @param {string} emailPrefix
 * @param {number} limit
 * @returns {Promise<{ items: object[], nextKey: string|null }>}
 */
const scanEmailPrefix = async (emailPrefix, limit) => {
  // DynamoDB cannot do begins_with on PK in a Query - PK must be exact.
  // For partial email search, we scan with a filter on PK begins_with EMAIL#{prefix}.
  // This is acceptable for MVP with < 5000 users per product scope.
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.EMAIL}${emailPrefix}`,
      ':skPrefix': KEY_PREFIXES.USER,
    },
    Limit: limit,
  }));

  const items = result.Items || [];
  const users = await resolveEmailLookups(items);
  const nextKey = result.LastEvaluatedKey
    ? encodeLastKey(result.LastEvaluatedKey)
    : null;
  return { items: users, nextKey };
};

/**
 * Resolve EMAIL lookup records to full user search results.
 * Each EMAIL lookup has userId - fetch latest lifecycle record for each.
 * @param {object[]} emailLookups
 * @returns {Promise<object[]>}
 */
const resolveEmailLookups = async (emailLookups) => {
  const results = [];
  for (const lookup of emailLookups) {
    const userId = lookup.userId || lookup.SK?.replace(KEY_PREFIXES.USER, '');
    if (!userId) continue;

    const userResults = await searchByUserId(userId);
    if (userResults.length > 0) {
      results.push(userResults[0]);
    } else {
      // Fallback: build result from lookup record itself
      results.push({
        userId,
        email: lookup.email || null,
        identitySource: lookup.source || null,
        status: null,
        createdAt: lookup.createdAt || null,
        deepLink: `/users/${userId}/detail`,
      });
    }
  }
  return results;
};

/**
 * Format a lifecycle DynamoDB item as a search result.
 * @param {object} item
 * @returns {object}
 */
const formatSearchResult = (item) => ({
  userId: item.userId,
  userName: item.newState?.name || item.newState?.userName || item.email || null,
  email: item.email || item.newState?.email || null,
  identitySource: item.source || null,
  status: item.newState?.status || deriveStatus(item),
  createdAt: item.createdAt,
  deepLink: `/users/${item.userId}/detail`,
});

/**
 * Derive user status from the latest lifecycle event.
 * @param {object} item
 * @returns {string}
 */
const deriveStatus = (item) => {
  if (item.eventType === EVENT_TYPES.DELETED) return 'DELETED';
  if (item.eventType === EVENT_TYPES.DISABLED || item.eventType === EVENT_TYPES.DISABLED_AT_SOURCE) return 'DISABLED';
  return 'ACTIVE';
};

/**
 * Apply identity source and status filters to search results.
 * @param {object[]} results
 * @param {string|undefined} source - Identity source filter
 * @param {string|undefined} status - Status filter
 * @returns {object[]}
 */
const applyFilters = (results, source, status) => {
  let filtered = results;
  if (source) {
    const upperSource = source.toUpperCase();
    filtered = filtered.filter((r) => r.identitySource === upperSource);
  }
  if (status) {
    const upperStatus = status.toUpperCase();
    filtered = filtered.filter((r) => r.status === upperStatus);
  }
  return filtered;
};

/**
 * Enrich search results with lastActiveAt, lastRecertDecision, and deep link.
 * @param {object[]} results
 * @returns {Promise<object[]>}
 */
const enrichResults = async (results) => {
  const enriched = await Promise.all(results.map(enrichSingleResult));
  return enriched;
};

/**
 * Enrich a single search result with activity and recert data.
 * @param {object} result
 * @returns {Promise<object>}
 */
const enrichSingleResult = async (result) => {
  if (!result.userId) return result;

  const [activityData, recertData] = await Promise.all([
    queryLatestActivity(result.userId),
    queryLatestRecert(result.userId),
  ]);

  return {
    ...result,
    lastActiveAt: activityData?.lastLoginAt || activityData?.createdAt || null,
    lastRecertDecision: recertData?.decision || null,
  };
};

/**
 * Query the latest ACTIVITY_DAILY record for a user.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
const queryLatestActivity = async (userId) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.USER}${userId}`,
      ':skPrefix': 'ACTIVITY_DAILY#',
    },
    ScanIndexForward: false,
    Limit: 1,
  }));

  return result.Items?.[0] || null;
};

/**
 * Query the latest RECERT record for a user.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
const queryLatestRecert = async (userId) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.USER}${userId}`,
      ':skPrefix': SK_PREFIXES.RECERT,
    },
    ScanIndexForward: false,
    Limit: 1,
  }));

  return result.Items?.[0] || null;
};

// User detail endpoint (6.1–6.2) 

/**
 * GET /users/{userId}/detail
 * Consolidated cross-pillar view of a single user.
 * @param {object} event
 * @returns {object} API response
 */
const handleUserDetail = async (event) => {
  const userId = event.pathParameters?.userId;
  if (!userId) {
    return errorResponse(400, 'userId is required');
  }

  const [lifecycle, activity, recertification, syncStatus] = await Promise.all([
    queryUserLifecycle(userId),
    queryUserActivity(userId),
    queryUserRecertification(userId),
    queryUserSyncStatus(userId),
  ]);

  const detail = assembleUserDetail(userId, lifecycle, activity, recertification, syncStatus);

  logInfo('USER_DETAIL_QUERY', { userId });

  return successResponse(200, detail);
};

/**
 * Query lifecycle events for a user.
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
const queryUserLifecycle = async (userId) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.USER}${userId}`,
      ':skPrefix': SK_PREFIXES.LIFECYCLE,
    },
    ScanIndexForward: true,
  }));
  return result.Items || [];
};

/**
 * Query latest activity records for a user (up to 30 days).
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
const queryUserActivity = async (userId) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.USER}${userId}`,
      ':skPrefix': 'ACTIVITY_DAILY#',
    },
    ScanIndexForward: false,
    Limit: 30,
  }));
  return result.Items || [];
};

/**
 * Query recertification history for a user.
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
const queryUserRecertification = async (userId) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.USER}${userId}`,
      ':skPrefix': SK_PREFIXES.RECERT,
    },
    ScanIndexForward: false,
  }));
  return result.Items || [];
};

/**
 * Query sync status records for a user.
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
const queryUserSyncStatus = async (userId) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.USER}${userId}`,
      ':skPrefix': SK_PREFIXES.SYNC,
    },
    ScanIndexForward: false,
  }));
  return result.Items || [];
};

/**
 * Assemble consolidated user detail from parallel query results.
 * @param {string} userId
 * @param {object[]} lifecycle
 * @param {object[]} activity
 * @param {object[]} recertification
 * @param {object[]} syncStatus
 * @returns {object}
 */
const assembleUserDetail = (userId, lifecycle, activity, recertification, syncStatus) => {
  const latestEvent = lifecycle[lifecycle.length - 1] || null;
  // TODO: Wire up identity adapter layer getUser(userId) for full identity info
  const identity = buildIdentityFromLifecycle(userId, latestEvent);
  const activitySummary = buildActivitySummary(activity);
  const evidenceLinks = extractEvidenceLinks(lifecycle);

  return {
    userId,
    identity,
    lifecycle: lifecycle.map(formatTimelineItem),
    activitySummary,
    recertificationHistory: recertification.map(formatRecertItem),
    syncStatus: syncStatus.map(formatSyncItem),
    evidenceLinks,
  };
};

/**
 * Build identity info from the latest lifecycle event.
 * @param {string} userId
 * @param {object|null} latestEvent
 * @returns {object}
 */
const buildIdentityFromLifecycle = (userId, latestEvent) => ({
  userId,
  email: latestEvent?.email || latestEvent?.newState?.email || null,
  name: latestEvent?.newState?.name || latestEvent?.newState?.userName || null,
  identitySource: latestEvent?.source || null,
  status: latestEvent ? deriveStatus(latestEvent) : null,
  createdAt: latestEvent?.createdAt || null,
});

/**
 * Build activity summary from daily activity records.
 * @param {object[]} activityRecords
 * @returns {object}
 */
const buildActivitySummary = (activityRecords) => {
  if (activityRecords.length === 0) {
    return { lastLoginAt: null, loginCount30d: 0, uniqueIPs: [], failedLogins30d: 0, inactive: true };
  }
  const latest = activityRecords[0];
  const loginCount30d = activityRecords.reduce((sum, r) => sum + (r.loginCount || 0), 0);
  const failedLogins30d = activityRecords.reduce((sum, r) => sum + (r.failedLoginCount || 0), 0);
  const allIPs = activityRecords.flatMap((r) => r.uniqueIPs || []);
  const uniqueIPs = [...new Set(allIPs)];

  return {
    lastLoginAt: latest.lastLoginAt || latest.createdAt || null,
    loginCount30d,
    uniqueIPs,
    failedLogins30d,
    inactive: false,
  };
};

/**
 * Format a recertification record for the detail view.
 * @param {object} item
 * @returns {object}
 */
const formatRecertItem = (item) => ({
  cycleId: item.SK?.replace(SK_PREFIXES.RECERT, '') || null,
  decision: item.decision || null,
  decidedBy: item.decidedBy || item.actorId || null,
  decidedAt: item.createdAt || null,
  notes: item.notes || null,
});

/**
 * Format a sync status record for the detail view.
 * @param {object} item
 * @returns {object}
 */
const formatSyncItem = (item) => ({
  source: item.SK?.replace(SK_PREFIXES.SYNC, '') || null,
  status: item.syncStatus || item.status || null,
  lastSyncAt: item.lastSyncAt || item.createdAt || null,
  orphanStatus: item.orphanStatus || null,
});

/**
 * Extract S3 evidence links from lifecycle records.
 * @param {object[]} lifecycle
 * @returns {object[]}
 */
const extractEvidenceLinks = (lifecycle) => {
  return lifecycle
    .filter((item) => item.evidenceS3Key)
    .map((item) => ({
      eventType: item.eventType,
      timestamp: item.createdAt,
      s3Key: item.evidenceS3Key,
      hash: item.evidenceHash || null,
    }));
};

// Dashboard endpoints (7.1–7.4) 

const VALID_PERIODS = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };
const VALID_GROUP_BY = ['day', 'week', 'month'];

/**
 * GET /dashboard/summary
 * Reads user counts from DynamoDB cache (STATS#DAILY). No live adapter calls.
 * @param {object} event
 * @returns {object} API response
 */
const handleDashboardSummary = async (event) => {
  const [userCounts, recentEvents] = await Promise.all([
    getCachedUserCounts(),
    queryRecentLifecycleEvents(10),
  ]);

  const totalUsers = Object.values(userCounts.bySource).reduce((s, n) => s + n, 0);

  const summary = {
    userCounts: {
      total: totalUsers,
      bySource: userCounts.bySource,
      byStatus: userCounts.byStatus,
    },
    recentEvents: recentEvents.map(formatRecentEvent),
    activitySnapshot: {
      activeToday: userCounts.enabledCount,
      activeThisWeek: totalUsers,
      inactive90Days: userCounts.disabledCount,
    },
    recertification: null,
    syncHealth: null,
    statsDate: toISOString(new Date()).slice(0, 10),
    syncPending: userCounts.syncPending || false,
  };

  logInfo('DASHBOARD_SUMMARY', { totalUsers, cached: true });

  return successResponse(200, summary);
};

/**
 * Get user counts from DynamoDB cache only (STATS#DAILY).
 * If no cache exists (first deploy), returns zeros with syncPending flag.
 */
const getCachedUserCounts = async () => {
  const today = toISOString(new Date()).slice(0, 10);

  const cached = await queryLatestDailyStats(today);
  if (cached && cached.createdAtEpoch) {
    return {
      bySource: cached.usersBySource || {},
      byStatus: cached.usersByStatus || {},
      enabledCount: cached.usersByStatus?.ACTIVE || 0,
      disabledCount: cached.usersByStatus?.DISABLED || 0,
      syncPending: false,
    };
  }

  // No cache exists - first deploy
  return {
    bySource: {},
    byStatus: {},
    enabledCount: 0,
    disabledCount: 0,
    syncPending: true,
  };
};

/**
 * Query the latest STATS#DAILY record.
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<object|null>}
 */
const queryLatestDailyStats = async (date) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND SK <= :sk',
    ExpressionAttributeValues: {
      ':pk': KEY_PREFIXES.STATS_DAILY,
      ':sk': date,
    },
    ScanIndexForward: false,
    Limit: 1,
  }));
  return result.Items?.[0] || null;
};

/**
 * Query last N lifecycle events from GSI1 across all event types.
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
const queryRecentLifecycleEvents = async (limit) => {
  const eventTypes = Object.values(EVENT_TYPES);
  const queries = eventTypes.map((type) => queryRecentByType(type, limit));
  const results = await Promise.all(queries);
  const all = results.flat();
  all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return all.slice(0, limit);
};

/**
 * Query recent events for a single event type via GSI1.
 * @param {string} eventType
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
const queryRecentByType = async (eventType, limit) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :gsi1pk',
    ExpressionAttributeValues: {
      ':gsi1pk': `${KEY_PREFIXES.TYPE}${eventType}`,
    },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return result.Items || [];
};

/**
 * Query the latest recertification cycle summary.
 * Queries CYCLE# records with SK=SUMMARY, returns the most recent.
 * @returns {Promise<object|null>}
 */
const queryLatestRecertCycle = async () => {
  // ASSUMPTION: CYCLE# PKs are ordered by cycleId (e.g. "2026-Q2").
  // We query a known prefix and take the latest. Since we can't do begins_with
  // on PK in a Query, we use a GSI or scan. For MVP, return null if no cycle found.
  // The stats aggregator will pre-compute this into STATS#DAILY.
  // For now, attempt to read from the latest stats record.
  return null;
};

/**
 * Query the latest reconciliation run.
 * @returns {Promise<object|null>}
 */
const queryLatestReconciliation = async () => {
  // ASSUMPTION: Reconciliation records use PK=RECONCILIATION#{date}.
  // Without a GSI on reconciliation, we rely on pre-computed stats.
  // For MVP, return null - the stats aggregator will populate this.
  return null;
};

/**
 * Assemble dashboard summary from query results.
 * @param {object|null} stats
 * @param {object[]} recentEvents
 * @param {object|null} recertCycle
 * @param {object|null} reconciliation
 * @returns {object}
 */
const assembleDashboardSummary = (stats, recentEvents, recertCycle, reconciliation) => ({
  userCounts: {
    total: stats?.totalUsers || 0,
    bySource: stats?.usersBySource || {},
    byStatus: stats?.usersByStatus || {},
  },
  recentEvents: recentEvents.map(formatRecentEvent),
  activitySnapshot: {
    activeToday: stats?.activeToday || 0,
    activeThisWeek: stats?.activeThisWeek || 0,
    inactive90Days: stats?.inactive90Days || 0,
  },
  recertification: recertCycle ? {
    cycleId: recertCycle.cycleId || null,
    status: recertCycle.status || null,
    completionPercentage: recertCycle.completionPercentage || 0,
    overdueCount: recertCycle.overdueCount || 0,
  } : null,
  syncHealth: reconciliation ? {
    lastReconciliationAt: reconciliation.createdAt || null,
    orphanCount: reconciliation.orphanCount || 0,
    pendingDeletionProofs: reconciliation.pendingDeletionProofs || 0,
  } : null,
  statsDate: stats?.SK || null,
});

/**
 * Format a lifecycle event for the recent events list.
 * @param {object} item
 * @returns {object}
 */
const formatRecentEvent = (item) => ({
  userId: item.email || item.userId,
  eventType: item.eventType,
  source: item.source,
  timestamp: item.createdAt,
});

/**
 * GET /dashboard/events/timeline
 * Event counts grouped by time period - queries GSI1 live for each event type.
 * @param {object} event
 * @returns {object} API response
 */
const handleDashboardTimeline = async (event) => {
  const queryParams = event.queryStringParameters || {};
  const period = queryParams.period || '30d';
  const groupBy = queryParams.groupBy || 'day';

  if (!VALID_PERIODS[period]) {
    return errorResponse(400, `Invalid period. Must be one of: ${Object.keys(VALID_PERIODS).join(', ')}`);
  }
  if (!VALID_GROUP_BY.includes(groupBy)) {
    return errorResponse(400, `Invalid groupBy. Must be one of: ${VALID_GROUP_BY.join(', ')}`);
  }

  const days = VALID_PERIODS[period];
  const { startDate, endDate } = computeDateRange(days);
  const startISO = `${startDate}T00:00:00.000Z`;
  const endISO = `${endDate}T23:59:59.999Z`;

  // Query GSI1 live for each event type within the date range
  const eventTypes = Object.values(EVENT_TYPES);
  const queries = eventTypes.map((type) => queryEventsInRange(type, startISO, endISO));
  const results = await Promise.all(queries);

  // Build buckets from actual events
  const bucketMap = new Map();
  eventTypes.forEach((type, i) => {
    for (const item of results[i]) {
      const date = (item.createdAt || item.GSI1SK || '').slice(0, 10);
      if (!date) continue;
      const bucketKey = deriveBucketKey(date, groupBy);
      if (!bucketMap.has(bucketKey)) {
        bucketMap.set(bucketKey, { bucket: bucketKey, CREATED: 0, MODIFIED: 0, DELETED: 0, DISABLED: 0, DISABLED_AT_SOURCE: 0, total: 0 });
      }
      const bucket = bucketMap.get(bucketKey);
      bucket[type] = (bucket[type] || 0) + 1;
      bucket.total++;
    }
  });

  const buckets = [...bucketMap.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));

  logInfo('DASHBOARD_TIMELINE_LIVE', { period, groupBy, bucketCount: buckets.length });

  return successResponse(200, { period, groupBy, buckets });
};

/**
 * Query events for a specific type within a date range via GSI1.
 * @param {string} eventType
 * @param {string} startISO
 * @param {string} endISO
 * @returns {Promise<object[]>}
 */
const queryEventsInRange = async (eventType, startISO, endISO) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.TYPE}${eventType}`,
      ':start': startISO,
      ':end': endISO,
    },
    ProjectionExpression: 'createdAt, GSI1SK',
  }));
  return result.Items || [];
};

/**
 * Compute start and end date strings for a given number of days back.
 * @param {number} days
 * @returns {{ startDate: string, endDate: string }}
 */
const computeDateRange = (days) => {
  const now = new Date();
  const end = toISOString(now).slice(0, 10);
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { startDate: toISOString(start).slice(0, 10), endDate: end };
};

/**
 * Query STATS#DAILY records for a date range.
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Promise<object[]>}
 */
const queryDailyStatsRange = async (startDate, endDate) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND SK BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':pk': KEY_PREFIXES.STATS_DAILY,
      ':start': startDate,
      ':end': endDate,
    },
    ScanIndexForward: true,
  }));
  return result.Items || [];
};

/**
 * Aggregate stats records into time buckets.
 * @param {object[]} records
 * @param {string} groupBy - 'day', 'week', or 'month'
 * @returns {object[]}
 */
const aggregateByTimeBucket = (records, groupBy) => {
  const bucketMap = new Map();

  for (const record of records) {
    const date = record.SK || '';
    const bucketKey = deriveBucketKey(date, groupBy);
    if (!bucketMap.has(bucketKey)) {
      bucketMap.set(bucketKey, { bucket: bucketKey, CREATED: 0, MODIFIED: 0, DELETED: 0, DISABLED: 0, DISABLED_AT_SOURCE: 0, total: 0 });
    }
    const bucket = bucketMap.get(bucketKey);
    const eventCounts = record.eventCounts || {};
    for (const [type, count] of Object.entries(eventCounts)) {
      bucket[type] = (bucket[type] || 0) + count;
      bucket.total += count;
    }
  }

  return [...bucketMap.values()];
};

/**
 * Derive the bucket key for a date based on groupBy strategy.
 * @param {string} date - YYYY-MM-DD
 * @param {string} groupBy - 'day', 'week', or 'month'
 * @returns {string}
 */
const deriveBucketKey = (date, groupBy) => {
  if (groupBy === 'day') return date;
  if (groupBy === 'month') return date.slice(0, 7);
  // week: ISO week start (Monday)
  const d = new Date(date + 'T00:00:00Z');
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d.getTime() + diff * 24 * 60 * 60 * 1000);
  return toISOString(monday).slice(0, 10);
};

/**
 * GET /dashboard/users/distribution
 * Cached user distribution data for pie/donut charts.
 * @param {object} event
 * @returns {object} API response
 */
const handleDashboardDistribution = async (event) => {
  const userCounts = await getCachedUserCounts();

  return successResponse(200, {
    bySource: userCounts.bySource,
    byStatus: userCounts.byStatus,
    byCreationMonth: [],
    byRecertDecision: null,
    syncPending: userCounts.syncPending || false,
  });
};

/**
 * Build creation histogram from stats record (last 12 months).
 * @param {object|null} stats
 * @returns {object[]}
 */
const buildCreationHistogram = (stats) => {
  if (!stats?.creationsByMonth) return [];
  return Object.entries(stats.creationsByMonth).map(([month, count]) => ({
    month,
    count,
  }));
};

// Shared helpers 

/**
 * Parse limit query parameter with default and bounds.
 * @param {string|undefined} limitStr
 * @returns {number}
 */
const parseLimit = (limitStr) => {
  if (!limitStr) return DEFAULT_LIMIT;
  const parsed = parseInt(limitStr, 10);
  if (isNaN(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, 200);
};

/**
 * Decode base64-encoded lastEvaluatedKey.
 * @param {string|undefined} encoded
 * @returns {object|null}
 */
const decodeLastKey = (encoded) => {
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
};

/**
 * Encode lastEvaluatedKey as base64 string.
 * @param {object} key
 * @returns {string}
 */
const encodeLastKey = (key) => {
  return Buffer.from(JSON.stringify(key)).toString('base64');
};

/**
 * Validate that startDate is before endDate.
 * @param {string} startDate
 * @param {string} endDate
 * @returns {boolean}
 */
const isValidDateRange = (startDate, endDate) => {
  return startDate <= endDate;
};

// Exported for testing
export {
  resolveRoute,
  handleTimeline,
  handleDeletionProof,
  handleExport,
  handleSearch,
  buildTimelineQuery,
  formatTimelineItem,
  queryDeletionLifecycleEvents,
  queryDeletionProofRecords,
  assembleEvidenceChain,
  queryExportData,
  queryGSI1ByType,
  generateCsv,
  formatCsvRow,
  escapeCsvField,
  summarizeDetails,
  generatePdf,
  buildPdfResponse,
  buildCsvResponse,
  buildRawPdf,
  pdfEscape,
  truncateStr,
  parseLimit,
  parseSearchLimit,
  decodeLastKey,
  encodeLastKey,
  isValidDateRange,
  executeSearch,
  searchByUserId,
  searchByUserIdPrefix,
  searchBroadText,
  searchByEmailPrefix,
  resolveEmailLookups,
  formatSearchResult,
  deriveStatus,
  applyFilters,
  enrichResults,
  enrichSingleResult,
  queryLatestActivity,
  queryLatestRecert,
  DEFAULT_LIMIT,
  SEARCH_DEFAULT_LIMIT,
  handleUserDetail,
  queryUserLifecycle,
  queryUserActivity,
  queryUserRecertification,
  queryUserSyncStatus,
  assembleUserDetail,
  buildIdentityFromLifecycle,
  buildActivitySummary,
  formatRecertItem,
  formatSyncItem,
  extractEvidenceLinks,
  handleDashboardSummary,
  handleDashboardTimeline,
  handleDashboardDistribution,
  queryLatestDailyStats,
  queryRecentLifecycleEvents,
  queryRecentByType,
  queryLatestRecertCycle,
  queryLatestReconciliation,
  assembleDashboardSummary,
  formatRecentEvent,
  computeDateRange,
  queryDailyStatsRange,
  aggregateByTimeBucket,
  deriveBucketKey,
  buildCreationHistogram,
  VALID_PERIODS,
  VALID_GROUP_BY,
};
