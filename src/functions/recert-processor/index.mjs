/**
 * Recert Processor Lambda - processes owner certify/revoke/modify decisions,
 * provides cycle and review query APIs, and enforces decision immutability.
 * Uses OWNER#{ownerEmail} PK for review items (resource-centric model).
 * REVOKED = create revocation ticket for IT admin review (not automated resource modification).
 * @module functions/recert-processor
 */

import {
  PutCommand, QueryCommand, GetCommand, UpdateCommand, DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ddbClient, TABLE_NAME } from '../../shared/dynamo-client.mjs';
import { toISOString, toIST, toEpoch } from '../../shared/time-utils.mjs';
import { computeEvidenceHash } from '../../shared/crypto-utils.mjs';
import {
  successResponse, errorResponse,
  KEY_PREFIXES, SK_PREFIXES, ENTITY_TYPES,
} from '../../shared/constants.mjs';

const lambdaClient = new LambdaClient({});
const s3Client = new S3Client({});
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET || '';
const MAX_EXTENSION_DAYS = 7;

// Router 

export const handler = async (event) => {
  try {
    if (!event.httpMethod) {
      return await handleAsyncEvent(event);
    }
    return await routeApiRequest(event);
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'RECERT_PROCESSOR_ERROR',
      message: error.message,
      function: 'recert-processor',
      timestamp: toISOString(new Date()),
    }));
    if (event.httpMethod) {
      return errorResponse(500, 'Internal server error');
    }
  }
};

const routeApiRequest = async (event) => {
  const { httpMethod, path, pathParameters } = event;

  if (httpMethod === 'POST' && path?.includes('/extend')) {
    return await handleExtendDeadline(event);
  }
  if (httpMethod === 'POST' && path?.includes('/transfer')) {
    return await handleTransferReviews(event);
  }
  if (httpMethod === 'POST' && path?.includes('/recert/decisions')) {
    return await handleDecisions(event);
  }
  if (httpMethod === 'GET' && path?.includes('/recert/my-reviews')) {
    return await handleMyReviews(event);
  }
  if (httpMethod === 'GET' && pathParameters?.cycleId && path?.includes('/recert/cycles')) {
    return await handleGetCycle(event);
  }
  if (httpMethod === 'GET' && pathParameters?.userId && path?.includes('/history')) {
    return await handleUserHistory(event);
  }
  if (httpMethod === 'GET' && path?.includes('/dashboard/recert/summary')) {
    return await handleDashboardSummary(event);
  }
  return errorResponse(404, 'Not found');
};

const handleAsyncEvent = async (event) => {
  const action = event.action || event.detail?.action;
  if (action === 'EXECUTE_REVOCATION') {
    // Resource-centric model: revocation creates a ticket, not automated action.
    // Legacy async revocation events are handled gracefully.
    const { default: executeRevocation } = await import('./revocation-handler.mjs');
    return await executeRevocation(event);
  }
  if (action === 'OVERDUE_ESCALATION') {
    const cycleId = event.cycleId || event.detail?.cycleId;
    if (cycleId) return await handleOverdueEscalation(cycleId);
  }
  console.log(JSON.stringify({
    action: 'PROCESSOR_ASYNC_NO_OP',
    event,
    timestamp: toISOString(new Date()),
  }));
};

// POST /recert/decisions 

const handleDecisions = async (event) => {
  const body = JSON.parse(event.body || '{}');
  const { decisions, cycleId } = body;

  if (!cycleId || !Array.isArray(decisions) || decisions.length === 0) {
    return errorResponse(400, 'cycleId and decisions[] are required');
  }

  const ownerEmail = extractOwnerEmail(event);
  if (!ownerEmail) {
    return errorResponse(401, 'Owner identity required');
  }

  const actorId = event.requestContext?.authorizer?.claims?.sub || ownerEmail;
  const onBehalfOf = body.onBehalfOf || null;
  const results = [];
  let certifiedCount = 0;
  let revokedCount = 0;
  let modifiedCount = 0;

  for (const d of decisions) {
    // Route to per-principal or legacy processing
    if (d.principalArn) {
      const result = await processPerPrincipalDecision({
        cycleId,
        ownerEmail,
        actorId,
        resourceArn: d.resourceArn || d.userId,
        principalArn: d.principalArn,
        decision: d.decision,
        reason: d.reason || null,
        resourceType: d.resourceType || 'unknown',
      });
      results.push(result);

      if (result.status === 'VALIDATION_ERROR') {
        return errorResponse(400, result.error);
      }

      if (result.status === 'PROCESSED') {
        if (d.decision === 'CERTIFIED') certifiedCount++;
        else if (d.decision === 'REVOKED') revokedCount++;
        else if (d.decision === 'MODIFIED') modifiedCount++;
      }
    } else {
      const result = await processDecision({
        cycleId,
        ownerEmail,
        actorId,
        onBehalfOf,
        resourceArn: d.resourceArn || d.userId,
        decision: d.decision,
        reason: d.reason || null,
        comment: d.comment || null,
        reviewDurationSeconds: d.reviewDurationSeconds || 0,
        resourceType: d.resourceType || 'unknown',
        partialRevoke: d.partialRevoke || null,
      });
      results.push(result);

      // Return 400 immediately for partialRevoke validation errors
      if (result.status === 'VALIDATION_ERROR') {
        return errorResponse(400, result.error);
      }

      if (result.status === 'PROCESSED') {
        if (d.decision === 'CERTIFIED') certifiedCount++;
        else if (d.decision === 'REVOKED') revokedCount++;
        else if (d.decision === 'MODIFIED') modifiedCount++;
      }
    }
  }

  if (certifiedCount + revokedCount + modifiedCount > 0) {
    await updateCycleSummary(cycleId, certifiedCount, revokedCount, modifiedCount);
    await checkCycleCompletion(cycleId);
  }

  return successResponse(200, { cycleId, results });
};

/** Supported resource types for automated revocation */
const SUPPORTED_REVOCATION_TYPES = new Set(['s3:bucket', 'iam:user']);

// Per-Principal Decision Processing 

/**
 * Process a per-principal decision (V2 user-centric model).
 * Validates principalArn against accessEntries, creates per-principal audit record,
 * handles revocation, and tracks resource completion.
 */
const processPerPrincipalDecision = async ({ cycleId, ownerEmail, actorId, resourceArn, principalArn, decision, reason, resourceType }) => {
  const validDecisions = ['CERTIFIED', 'REVOKED', 'MODIFIED'];
  if (!validDecisions.includes(decision)) {
    return { resourceArn, principalArn, status: 'INVALID_DECISION', error: `Decision must be one of: ${validDecisions.join(', ')}` };
  }

  // Fetch review item to validate principalArn exists in accessEntries
  const reviewItem = await fetchReviewItem({ ownerEmail, cycleId, resourceArn });
  if (!reviewItem) {
    return { resourceArn, principalArn, status: 'VALIDATION_ERROR', error: 'Resource review item not found' };
  }

  const accessEntries = reviewItem.accessEntries || [];
  const principalEntry = accessEntries.find((e) => e.principalArn === principalArn);
  if (!principalEntry) {
    return { resourceArn, principalArn, status: 'VALIDATION_ERROR', error: `Principal ${principalArn} not found in resource accessEntries` };
  }

  // Check immutability - reject duplicate per-principal decisions
  const existingDecision = await ddbClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: `${KEY_PREFIXES.RESOURCE}${resourceArn}`,
      SK: `${SK_PREFIXES.RECERT}${cycleId}#PRINCIPAL#${principalArn}`,
    },
  }));

  if (existingDecision.Item) {
    return { resourceArn, principalArn, status: 'CONFLICT', error: 'Decision already exists for this principal and cycle' };
  }

  // Create per-principal audit record
  const now = new Date();
  const evidenceHash = computeEvidenceHash({
    userId: resourceArn,
    eventType: `RECERT_${decision}`,
    timestamp: toISOString(now),
    metadata: { cycleId, ownerEmail, principalArn, reason },
  });

  try {
    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `${KEY_PREFIXES.RESOURCE}${resourceArn}`,
        SK: `${SK_PREFIXES.RECERT}${cycleId}#PRINCIPAL#${principalArn}`,
        GSI1PK: `${KEY_PREFIXES.TYPE}RECERT_DECISION`,
        GSI1SK: toISOString(now),
        entityType: ENTITY_TYPES.RECERT_DECISION,
        cycleId,
        resourceArn,
        principalArn,
        principalName: principalEntry.principalName,
        decision,
        reason,
        actorId,
        evidenceHash,
        createdAt: toISOString(now),
        createdAtEpoch: toEpoch(now),
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return { resourceArn, principalArn, status: 'CONFLICT', error: 'Decision already exists for this principal and cycle' };
    }
    throw error;
  }

  // Handle revocation for REVOKED decisions
  if (decision === 'REVOKED') {
    await handlePerPrincipalRevocation({
      cycleId, resourceArn, resourceType, principalArn,
      accessSource: principalEntry.accessSource,
      ownerEmail, actorId, reason, accessInfo: reviewItem.accessInfo,
    });
  }

  // Check per-principal completion for the resource
  await checkPrincipalCompletion({ ownerEmail, cycleId, resourceArn, accessEntries });

  return { resourceArn, principalArn, decision, status: 'PROCESSED' };
};

/**
 * Fetch the full review item from DynamoDB.
 */
const fetchReviewItem = async ({ ownerEmail, cycleId, resourceArn }) => {
  try {
    const result = await ddbClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `${KEY_PREFIXES.OWNER}${ownerEmail}`,
        SK: `${SK_PREFIXES.RECERT_ITEM}${cycleId}#${resourceArn}`,
      },
    }));
    return result.Item || null;
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'FETCH_REVIEW_ITEM_FAILED',
      ownerEmail, cycleId, resourceArn,
      message: error.message,
      timestamp: toISOString(new Date()),
    }));
    return null;
  }
};

/**
 * Handle per-principal revocation by invoking executeUserRevocation.
 */
const handlePerPrincipalRevocation = async ({ cycleId, resourceArn, resourceType, principalArn, accessSource, ownerEmail, actorId, reason, accessInfo }) => {
  try {
    const { executeUserRevocation } = await import('./revocation-handler.mjs');
    await executeUserRevocation({
      resourceArn,
      principalArn,
      accessSource,
      cycleId,
      ownerEmail,
      actorId,
      reason,
      accessInfo,
    });
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'PER_PRINCIPAL_REVOCATION_FAILED',
      cycleId, resourceArn, principalArn,
      message: error.message,
      timestamp: toISOString(new Date()),
    }));
    // Fall back to ticket creation
    await createRevocationTicket({ cycleId, resourceArn, resourceType, ownerEmail, actorId, reason, comment: null });
  }
};

/**
 * Check if all principals in a resource have been decided.
 * If so, mark the resource review item as complete.
 */
const checkPrincipalCompletion = async ({ ownerEmail, cycleId, resourceArn, accessEntries }) => {
  if (!accessEntries || accessEntries.length === 0) return;

  // Query all per-principal decisions for this resource+cycle
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.RESOURCE}${resourceArn}`,
      ':sk': `${SK_PREFIXES.RECERT}${cycleId}#PRINCIPAL#`,
    },
  }));

  const decidedCount = (result.Items || []).length;
  const totalPrincipals = accessEntries.length;

  if (decidedCount >= totalPrincipals) {
    // All principals decided - mark resource as complete
    await ddbClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `${KEY_PREFIXES.OWNER}${ownerEmail}`,
        SK: `${SK_PREFIXES.RECERT_ITEM}${cycleId}#${resourceArn}`,
      },
      UpdateExpression: 'SET #s = :status, principalCompletionPct = :pct',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':status': 'COMPLETED',
        ':pct': 100,
      },
    }));
  } else {
    // Update completion percentage
    const pct = Math.round((decidedCount / totalPrincipals) * 100);
    await ddbClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `${KEY_PREFIXES.OWNER}${ownerEmail}`,
        SK: `${SK_PREFIXES.RECERT_ITEM}${cycleId}#${resourceArn}`,
      },
      UpdateExpression: 'SET principalCompletionPct = :pct',
      ExpressionAttributeValues: { ':pct': pct },
    }));
  }
};

const processDecision = async ({ cycleId, ownerEmail, actorId, onBehalfOf, resourceArn, decision, reason, comment, reviewDurationSeconds, resourceType, partialRevoke }) => {
  const validDecisions = ['CERTIFIED', 'REVOKED', 'MODIFIED'];
  if (!validDecisions.includes(decision)) {
    return { resourceArn, status: 'INVALID_DECISION', error: `Decision must be one of: ${validDecisions.join(', ')}` };
  }

  // Check immutability - reject duplicate decisions
  const existingAudit = await ddbClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: `${KEY_PREFIXES.RESOURCE}${resourceArn}`,
      SK: `${SK_PREFIXES.RECERT}${cycleId}`,
    },
  }));

  if (existingAudit.Item) {
    return { resourceArn, status: 'CONFLICT', error: 'Decision already exists for this resource and cycle' };
  }

  // For REVOKED decisions, validate partialRevoke if present
  if (decision === 'REVOKED' && partialRevoke) {
    const validationError = await validatePartialRevoke({ ownerEmail, cycleId, resourceArn, partialRevoke });
    if (validationError) {
      return { resourceArn, status: 'VALIDATION_ERROR', error: validationError };
    }
  }

  const now = new Date();
  const effectiveDecisionStatus = (decision === 'REVOKED' && partialRevoke) ? 'PARTIAL_REVOKED' : decision;

  await updateReviewItem(ownerEmail, cycleId, resourceArn, effectiveDecisionStatus, reason, comment, actorId, onBehalfOf, now);

  await createDecisionAudit({
    cycleId, resourceArn, resourceType, ownerEmail, decision,
    reason, comment, reviewDurationSeconds, actorId, onBehalfOf, now,
  });

  if (decision === 'REVOKED') {
    await handleRevocation({ cycleId, resourceArn, resourceType, ownerEmail, actorId, reason, comment, partialRevoke });
  }

  return { resourceArn, decision, status: 'PROCESSED' };
};

/**
 * Validate partialRevoke payload against the resource's accessInfo.
 * Returns an error message string if invalid, or null if valid.
 */
const validatePartialRevoke = async ({ ownerEmail, cycleId, resourceArn, partialRevoke }) => {
  // Check that partialRevoke has at least one non-empty selection
  const hasSelections = (
    (partialRevoke.policyStatements && partialRevoke.policyStatements.length > 0)
    || (partialRevoke.aclGrants && partialRevoke.aclGrants.length > 0)
    || partialRevoke.enablePublicAccessBlock === true
    || (partialRevoke.managedPolicies && partialRevoke.managedPolicies.length > 0)
    || (partialRevoke.groups && partialRevoke.groups.length > 0)
    || (partialRevoke.accessKeys && partialRevoke.accessKeys.length > 0)
  );

  if (!hasSelections) {
    return 'partialRevoke list cannot be empty';
  }

  // Fetch the review item to get accessInfo
  const accessInfo = await fetchReviewItemAccessInfo({ ownerEmail, cycleId, resourceArn });
  if (!accessInfo) {
    return 'accessInfo not available for this resource; cannot validate partialRevoke';
  }

  // Validate each reference against accessInfo
  if (partialRevoke.policyStatements && partialRevoke.policyStatements.length > 0) {
    const validSids = (accessInfo.bucketPolicy?.Statement || []).map((s) => s.Sid).filter(Boolean);
    for (const sid of partialRevoke.policyStatements) {
      if (!validSids.includes(sid)) {
        return `partialRevoke item ${sid} not found in resource accessInfo`;
      }
    }
  }

  if (partialRevoke.aclGrants && partialRevoke.aclGrants.length > 0) {
    const validGrantees = (accessInfo.acl?.Grants || []).map(
      (g) => g.Grantee?.URI || g.Grantee?.ID || '',
    ).filter(Boolean);
    for (const grantee of partialRevoke.aclGrants) {
      if (!validGrantees.includes(grantee)) {
        return `partialRevoke item ${grantee} not found in resource accessInfo`;
      }
    }
  }

  if (partialRevoke.managedPolicies && partialRevoke.managedPolicies.length > 0) {
    const validPolicies = (accessInfo.attachedPolicies || []).map((p) => p.PolicyArn);
    for (const policyArn of partialRevoke.managedPolicies) {
      if (!validPolicies.includes(policyArn)) {
        return `partialRevoke item ${policyArn} not found in resource accessInfo`;
      }
    }
  }

  if (partialRevoke.groups && partialRevoke.groups.length > 0) {
    const validGroups = (accessInfo.groups || []).map((g) => g.GroupName);
    for (const groupName of partialRevoke.groups) {
      if (!validGroups.includes(groupName)) {
        return `partialRevoke item ${groupName} not found in resource accessInfo`;
      }
    }
  }

  if (partialRevoke.accessKeys && partialRevoke.accessKeys.length > 0) {
    const validKeys = (accessInfo.accessKeys || []).map((k) => k.AccessKeyId);
    for (const keyId of partialRevoke.accessKeys) {
      if (!validKeys.includes(keyId)) {
        return `partialRevoke item ${keyId} not found in resource accessInfo`;
      }
    }
  }

  return null;
};

/**
 * Fetch the review item's accessInfo from DynamoDB.
 * @returns {Object|null} accessInfo or null if not found
 */
const fetchReviewItemAccessInfo = async ({ ownerEmail, cycleId, resourceArn }) => {
  try {
    const result = await ddbClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `${KEY_PREFIXES.OWNER}${ownerEmail}`,
        SK: `${SK_PREFIXES.RECERT_ITEM}${cycleId}#${resourceArn}`,
      },
    }));
    return result.Item?.accessInfo || null;
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'FETCH_ACCESS_INFO_FAILED',
      ownerEmail, cycleId, resourceArn,
      message: error.message,
      timestamp: toISOString(new Date()),
    }));
    return null;
  }
};

/**
 * Handle revocation routing: automated for supported types, ticket for unsupported.
 * For partial revocations, always invokes executeRevocation with partialRevoke details.
 */
const handleRevocation = async ({ cycleId, resourceArn, resourceType, ownerEmail, actorId, reason, comment, partialRevoke }) => {
  const isSupported = SUPPORTED_REVOCATION_TYPES.has(resourceType);

  if (isSupported || partialRevoke) {
    // Fetch accessInfo for the revocation handler
    const accessInfo = await fetchReviewItemAccessInfo({ ownerEmail, cycleId, resourceArn });

    try {
      const { default: executeRevocation } = await import('./revocation-handler.mjs');
      await executeRevocation({
        resourceArn,
        resourceType,
        cycleId,
        ownerEmail,
        actorId,
        reason,
        partialRevoke,
        accessInfo,
      });
    } catch (error) {
      console.error(JSON.stringify({
        errorCode: 'REVOCATION_HANDLER_INVOCATION_FAILED',
        cycleId, resourceArn, resourceType,
        message: error.message,
        timestamp: toISOString(new Date()),
      }));
      // Fall back to ticket creation on handler failure
      await createRevocationTicket({ cycleId, resourceArn, resourceType, ownerEmail, actorId, reason, comment });
    }
  } else {
    // Unsupported type - create ticket as before
    await createRevocationTicket({ cycleId, resourceArn, resourceType, ownerEmail, actorId, reason, comment });
  }
};

const updateReviewItem = async (ownerEmail, cycleId, resourceArn, decision, reason, comment, actorId, onBehalfOf, now) => {
  const newGsi1Sk = `${cycleId}#${decision}`;

  try {
    await ddbClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `${KEY_PREFIXES.OWNER}${ownerEmail}`,
        SK: `${SK_PREFIXES.RECERT_ITEM}${cycleId}#${resourceArn}`,
      },
      UpdateExpression: 'SET #s = :decision, decision = :decision, decisionReason = :reason, decisionComment = :comment, decisionTimestamp = :ts, decisionActorId = :actor, onBehalfOf = :behalf, GSI1SK = :gsi1sk',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':decision': decision === 'MODIFIED' ? 'MODIFICATION_REQUESTED' : decision,
        ':reason': reason,
        ':comment': comment,
        ':ts': toISOString(now),
        ':actor': actorId,
        ':behalf': onBehalfOf,
        ':gsi1sk': newGsi1Sk,
      },
    }));
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'REVIEW_ITEM_UPDATE_FAILED',
      ownerEmail, cycleId, resourceArn,
      message: error.message,
      timestamp: toISOString(new Date()),
    }));
    throw error;
  }
};

const createDecisionAudit = async ({ cycleId, resourceArn, resourceType, ownerEmail, decision, reason, comment, reviewDurationSeconds, actorId, onBehalfOf, now }) => {
  const evidenceHash = computeEvidenceHash({
    userId: resourceArn,
    eventType: `RECERT_${decision}`,
    timestamp: toISOString(now),
    metadata: { cycleId, ownerEmail, reason },
  });

  await ddbClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `${KEY_PREFIXES.RESOURCE}${resourceArn}`,
      SK: `${SK_PREFIXES.RECERT}${cycleId}`,
      GSI1PK: `${KEY_PREFIXES.TYPE}RECERT_DECISION`,
      GSI1SK: toISOString(now),
      entityType: ENTITY_TYPES.RECERT_DECISION,
      cycleId,
      resourceArn,
      resourceType,
      ownerEmail,
      decision,
      reason,
      comment,
      reviewDurationSeconds,
      actorId,
      onBehalfOf,
      evidenceHash,
      createdAt: toISOString(now),
      createdAtEpoch: toEpoch(now),
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
};

/** Create a revocation ticket for IT admin review instead of automated resource modification. */
const createRevocationTicket = async ({ cycleId, resourceArn, resourceType, ownerEmail, actorId, reason, comment }) => {
  const now = new Date();
  try {
    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `${KEY_PREFIXES.TYPE}REVOCATION_TICKET`,
        SK: `${toISOString(now)}#${resourceArn}`,
        GSI1PK: `${KEY_PREFIXES.TYPE}REVOCATION_TICKET`,
        GSI1SK: toISOString(now),
        entityType: ENTITY_TYPES.REVOCATION_TICKET,
        cycleId,
        resourceArn,
        resourceType,
        ownerEmail,
        actorId: actorId || 'SYSTEM',
        reason: reason || 'Access revoked during recertification',
        comment: comment || '',
        ticketStatus: 'OPEN',
        createdAt: toISOString(now),
        createdAtEpoch: toEpoch(now),
      },
    }));
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'REVOCATION_TICKET_FAILED',
      cycleId, resourceArn,
      message: error.message,
      timestamp: toISOString(new Date()),
    }));
  }
};

// Cycle Summary Atomic Update 

const updateCycleSummary = async (cycleId, certified, revoked, modified) => {
  const completed = certified + revoked + modified;

  try {
    const cycleResult = await ddbClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `${KEY_PREFIXES.CYCLE}${cycleId}`, SK: SK_PREFIXES.SUMMARY },
    }));

    const totalResources = cycleResult.Item?.totalResources || cycleResult.Item?.totalUsers || 1;
    const currentCompleted = (cycleResult.Item?.completedCount || 0) + completed;
    const percentage = Math.round((currentCompleted / totalResources) * 100);

    await ddbClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `${KEY_PREFIXES.CYCLE}${cycleId}`, SK: SK_PREFIXES.SUMMARY },
      UpdateExpression: 'ADD completedCount :completed, certifiedCount :certified, revokedCount :revoked, modifiedCount :modified SET completionPercentage = :pct',
      ExpressionAttributeValues: {
        ':completed': completed,
        ':certified': certified,
        ':revoked': revoked,
        ':modified': modified,
        ':pct': percentage,
      },
    }));
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'CYCLE_SUMMARY_UPDATE_FAILED',
      cycleId,
      message: error.message,
      timestamp: toISOString(new Date()),
    }));
  }
};

// GET /recert/my-reviews 

const handleMyReviews = async (event) => {
  const ownerEmail = extractOwnerEmail(event);
  if (!ownerEmail) {
    return errorResponse(401, 'Owner identity required');
  }

  const cycleId = event.queryStringParameters?.cycleId;

  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.OWNER}${ownerEmail}`,
      ':sk': SK_PREFIXES.RECERT_ITEM,
    },
  }));

  let items = result.Items || [];

  if (cycleId) {
    items = items.filter((i) => i.cycleId === cycleId);
  }

  return successResponse(200, { ownerEmail, reviews: items });
};

// GET /recert/cycles/{cycleId} 

const handleGetCycle = async (event) => {
  const { cycleId } = event.pathParameters;

  const summaryResult = await ddbClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `${KEY_PREFIXES.CYCLE}${cycleId}`, SK: SK_PREFIXES.SUMMARY },
  }));

  if (!summaryResult.Item) {
    return errorResponse(404, `Cycle ${cycleId} not found`);
  }

  const itemsResult = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.TYPE}RECERT_ITEM`,
      ':sk': cycleId,
    },
  }));

  const reviewItems = itemsResult.Items || [];

  const ownerStats = {};
  for (const item of reviewItems) {
    const key = item.ownerEmail || 'unknown';
    if (!ownerStats[key]) {
      ownerStats[key] = { ownerEmail: key, total: 0, completed: 0, pending: 0 };
    }
    ownerStats[key].total++;
    if (item.status === 'PENDING') {
      ownerStats[key].pending++;
    } else {
      ownerStats[key].completed++;
    }
  }

  return successResponse(200, {
    cycle: summaryResult.Item,
    reviewItems,
    ownerStats: Object.values(ownerStats),
  });
};

// GET /recert/users/{userId}/history 

const handleUserHistory = async (event) => {
  const { userId } = event.pathParameters;

  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.USER}${userId}`,
      ':sk': SK_PREFIXES.RECERT,
    },
  }));

  const history = (result.Items || []).sort((a, b) => a.createdAt?.localeCompare(b.createdAt));

  return successResponse(200, { userId, history });
};

// Dashboard Summary 

const handleDashboardSummary = async () => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.TYPE}RECERT_DECISION`,
    },
    ScanIndexForward: false,
    Limit: 100,
  }));

  const decisions = result.Items || [];
  const certified = decisions.filter((d) => d.decision === 'CERTIFIED').length;
  const revoked = decisions.filter((d) => d.decision === 'REVOKED').length;
  const modified = decisions.filter((d) => d.decision === 'MODIFIED').length;

  return successResponse(200, {
    totalDecisions: decisions.length,
    certified,
    revoked,
    modified,
  });
};

// POST /recert/cycles/{cycleId}/extend 

const handleExtendDeadline = async (event) => {
  const { cycleId } = event.pathParameters || {};
  if (!cycleId) return errorResponse(400, 'cycleId is required');

  const ownerEmail = extractOwnerEmail(event);
  if (!ownerEmail) return errorResponse(401, 'Owner identity required');

  const body = JSON.parse(event.body || '{}');
  const { reason } = body;
  if (!reason) return errorResponse(400, 'reason is required');

  const existing = await findExistingExtension(ownerEmail, cycleId);
  if (existing) {
    return errorResponse(409, 'Extension already granted for this owner and cycle');
  }

  const cycle = await getCycleSummary(cycleId);
  if (!cycle) return errorResponse(404, `Cycle ${cycleId} not found`);

  const originalDeadline = new Date(cycle.deadline);
  const newDeadline = new Date(originalDeadline.getTime() + MAX_EXTENSION_DAYS * 24 * 60 * 60 * 1000);
  const now = new Date();

  await writeExtensionRecord(ownerEmail, cycleId, originalDeadline, newDeadline, reason, now);
  await updateOwnerDeadlines(ownerEmail, cycleId, newDeadline);

  return successResponse(200, {
    ownerEmail, cycleId,
    originalDeadline: toISOString(originalDeadline),
    newDeadline: toISOString(newDeadline),
    extensionDays: MAX_EXTENSION_DAYS,
  });
};

const findExistingExtension = async (ownerEmail, cycleId) => {
  const result = await ddbClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: `${KEY_PREFIXES.OWNER}${ownerEmail}`,
      SK: `EXTENSION#${cycleId}`,
    },
  }));
  return result.Item || null;
};

const writeExtensionRecord = async (ownerEmail, cycleId, originalDeadline, newDeadline, reason, now) => {
  await ddbClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `${KEY_PREFIXES.OWNER}${ownerEmail}`,
      SK: `EXTENSION#${cycleId}`,
      entityType: 'DEADLINE_EXTENSION',
      ownerEmail,
      cycleId,
      originalDeadline: toISOString(originalDeadline),
      newDeadline: toISOString(newDeadline),
      extensionDays: MAX_EXTENSION_DAYS,
      reason,
      createdAt: toISOString(now),
      createdAtEpoch: toEpoch(now),
    },
  }));
};

const updateOwnerDeadlines = async (ownerEmail, cycleId, newDeadline) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.OWNER}${ownerEmail}`,
      ':sk': `${SK_PREFIXES.RECERT_ITEM}${cycleId}`,
    },
  }));

  for (const item of (result.Items || [])) {
    await ddbClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: item.PK, SK: item.SK },
      UpdateExpression: 'SET deadline = :dl',
      ExpressionAttributeValues: { ':dl': toISOString(newDeadline) },
    }));
  }
};

// POST /recert/cycles/{cycleId}/transfer 

const handleTransferReviews = async (event) => {
  const { cycleId } = event.pathParameters || {};
  if (!cycleId) return errorResponse(400, 'cycleId is required');

  const body = JSON.parse(event.body || '{}');
  const { oldOwnerEmail, newOwnerEmail } = body;

  if (!oldOwnerEmail || !newOwnerEmail) {
    return errorResponse(400, 'oldOwnerEmail and newOwnerEmail are required');
  }

  const pendingItems = await queryPendingItems(oldOwnerEmail, cycleId);
  if (pendingItems.length === 0) {
    return errorResponse(404, 'No pending items found for old owner');
  }

  const now = new Date();
  let transferred = 0;

  for (const item of pendingItems) {
    await createTransferredItem(item, newOwnerEmail, now);
    await deleteOldItem(item);
    transferred++;
  }

  await writeTransferAudit(cycleId, oldOwnerEmail, newOwnerEmail, transferred, now);
  await triggerTransferNotification(cycleId, newOwnerEmail, transferred, oldOwnerEmail);

  return successResponse(200, {
    cycleId, oldOwnerEmail, newOwnerEmail, transferredCount: transferred,
  });
};

const queryPendingItems = async (ownerEmail, cycleId) => {
  const result = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.OWNER}${ownerEmail}`,
      ':sk': `${SK_PREFIXES.RECERT_ITEM}${cycleId}`,
    },
  }));
  return (result.Items || []).filter((i) => i.status === 'PENDING');
};

const createTransferredItem = async (item, newOwnerEmail, now) => {
  const newItem = {
    ...item,
    PK: `${KEY_PREFIXES.OWNER}${newOwnerEmail}`,
    ownerEmail: newOwnerEmail,
    transferredFrom: item.ownerEmail,
    transferredAt: toISOString(now),
  };
  await ddbClient.send(new PutCommand({ TableName: TABLE_NAME, Item: newItem }));
};

const deleteOldItem = async (item) => {
  await ddbClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: item.PK, SK: item.SK },
  }));
};

const writeTransferAudit = async (cycleId, oldOwnerEmail, newOwnerEmail, count, now) => {
  await ddbClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `${KEY_PREFIXES.CYCLE}${cycleId}`,
      SK: `TRANSFER#${toISOString(now)}`,
      entityType: 'REVIEW_TRANSFER',
      cycleId,
      oldOwnerEmail,
      newOwnerEmail,
      transferredCount: count,
      createdAt: toISOString(now),
      createdAtEpoch: toEpoch(now),
    },
  }));
};

const triggerTransferNotification = async (cycleId, newOwnerEmail, pendingCount, oldOwnerEmail) => {
  try {
    const functionName = process.env.RECERT_NOTIFIER_FUNCTION
      || `identity-governance-recert-notifier-${process.env.STAGE || 'dev'}`;
    await lambdaClient.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        action: 'TRANSFER_NOTIFICATION',
        cycleId,
        newOwnerEmail,
        pendingCount,
        oldOwnerEmail,
      }),
    }));
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'TRANSFER_NOTIFICATION_FAILED',
      cycleId, newOwnerEmail,
      message: error.message,
      timestamp: toISOString(new Date()),
    }));
  }
};

// Cycle Completion Detection 

const checkCycleCompletion = async (cycleId) => {
  const cycle = await getCycleSummary(cycleId);
  if (!cycle || cycle.status !== 'ACTIVE') return;

  const isComplete = cycle.completionPercentage >= 100;
  const isPastDeadline = new Date() > new Date(cycle.deadline);

  if (!isComplete && !isPastDeadline) return;

  const newStatus = isComplete ? 'COMPLETED' : 'COMPLETED_WITH_OVERDUE';

  await ddbClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `${KEY_PREFIXES.CYCLE}${cycleId}`, SK: SK_PREFIXES.SUMMARY },
    UpdateExpression: 'SET #s = :status, completedAt = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':status': newStatus,
      ':now': toISOString(new Date()),
    },
  }));

  if (isComplete) {
    await generateCycleReport(cycleId, cycle);
    await triggerSummaryEmail(cycleId);
  }
};

const getCycleSummary = async (cycleId) => {
  const result = await ddbClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `${KEY_PREFIXES.CYCLE}${cycleId}`, SK: SK_PREFIXES.SUMMARY },
  }));
  return result.Item || null;
};

// Report Generation 

const generateCycleReport = async (cycleId, cycle) => {
  if (!EVIDENCE_BUCKET) return;

  const report = buildReportData(cycle);
  const jsonKey = `reports/${cycleId}/report.json`;
  const csvKey = `reports/${cycleId}/report.csv`;

  await s3Client.send(new PutObjectCommand({
    Bucket: EVIDENCE_BUCKET,
    Key: jsonKey,
    Body: JSON.stringify(report, null, 2),
    ContentType: 'application/json',
  }));

  await s3Client.send(new PutObjectCommand({
    Bucket: EVIDENCE_BUCKET,
    Key: csvKey,
    Body: buildCsvReport(report),
    ContentType: 'text/csv',
  }));
};

const buildReportData = (cycle) => ({
  cycleId: cycle.cycleId,
  cycleType: cycle.cycleType,
  startDate: cycle.startDate,
  deadline: cycle.deadline,
  totalResources: cycle.totalResources || cycle.totalUsers || 0,
  totalOwners: cycle.totalOwners || 0,
  totalUnownedResources: cycle.totalUnownedResources || 0,
  resourcesByService: cycle.resourcesByService || {},
  certifiedCount: cycle.certifiedCount || 0,
  revokedCount: cycle.revokedCount || 0,
  modifiedCount: cycle.modifiedCount || 0,
  completionPercentage: cycle.completionPercentage || 0,
  generatedAt: toISOString(new Date()),
});

const buildCsvReport = (report) => {
  const headers = Object.keys(report).join(',');
  const values = Object.values(report).join(',');
  return `${headers}\n${values}\n`;
};

const triggerSummaryEmail = async (cycleId) => {
  try {
    const functionName = process.env.RECERT_NOTIFIER_FUNCTION
      || `identity-governance-recert-notifier-${process.env.STAGE || 'dev'}`;
    await lambdaClient.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({ action: 'CYCLE_COMPLETE', cycleId }),
    }));
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'SUMMARY_EMAIL_FAILED',
      cycleId,
      message: error.message,
      timestamp: toISOString(new Date()),
    }));
  }
};

// Overdue Escalation 

const handleOverdueEscalation = async (cycleId) => {
  const itemsResult = await ddbClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `${KEY_PREFIXES.TYPE}RECERT_ITEM`,
      ':sk': `${cycleId}#PENDING`,
    },
  }));

  const pendingItems = itemsResult.Items || [];
  const now = new Date();

  for (const item of pendingItems) {
    const deadline = new Date(item.deadline);
    const hoursPast = (now - deadline) / (1000 * 60 * 60);

    if (hoursPast > 48) {
      await escalateItem(item, 'REQUIRES_ADMIN_REVIEW');
    } else if (hoursPast > 0) {
      await escalateItem(item, 'ESCALATED');
    }
  }
};

const escalateItem = async (item, newStatus) => {
  await ddbClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: item.PK, SK: item.SK },
    UpdateExpression: 'SET #s = :status, escalatedAt = :now',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: {
      ':status': newStatus,
      ':now': toISOString(new Date()),
    },
  }));
};

// Helpers 

const extractOwnerEmail = (event) => {
  const claims = event.requestContext?.authorizer?.claims;
  return claims?.email || claims?.['cognito:username'] || claims?.sub || null;
};
