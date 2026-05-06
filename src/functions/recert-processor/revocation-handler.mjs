/**
 * Revocation handler - resource-centric model with automated revocation.
 * Supports automated S3 bucket and IAM user revocation (full and partial).
 * Unsupported resource types fall back to ticket creation for IT admin review.
 * @module functions/recert-processor/revocation-handler
 */

import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  S3Client,
  DeleteBucketPolicyCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
  PutBucketAclCommand,
  GetBucketPolicyCommand,
  GetPublicAccessBlockCommand,
  GetBucketAclCommand,
} from '@aws-sdk/client-s3';
import {
  IAMClient,
  DetachUserPolicyCommand,
  RemoveUserFromGroupCommand,
  UpdateAccessKeyCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupsForUserCommand,
  ListAccessKeysCommand,
} from '@aws-sdk/client-iam';
import { ddbClient, TABLE_NAME } from '../../shared/dynamo-client.mjs';
import { toISOString, toEpoch } from '../../shared/time-utils.mjs';
import { computeEvidenceHash } from '../../shared/crypto-utils.mjs';
import { KEY_PREFIXES, SK_PREFIXES, ENTITY_TYPES } from '../../shared/constants.mjs';
import { assumeCrossAccountRole } from '../../shared/cross-account-credentials.mjs';

const lambdaClient = new LambdaClient({});
const s3Client = new S3Client({});
const iamClient = new IAMClient({});
const MANAGEMENT_ACCOUNT_ID = process.env.MANAGEMENT_ACCOUNT_ID || '364170696417';

// Supported Type Registry 

const SUPPORTED_REVOCATION_TYPES = {
  's3:bucket': executeS3Revocation,
  'iam:user': executeIamRevocation,
};

// Main Entry Point 

/**
 * Handle revocation for a resource.
 * Routes to automated revocation for supported types, falls back to ticket creation.
 * @param {Object} event
 * @param {string} event.resourceArn - ARN of the resource
 * @param {string} event.resourceType - Type of resource (s3:bucket, iam:user, etc.)
 * @param {string} event.cycleId
 * @param {string} event.ownerEmail
 * @param {string} [event.actorId]
 * @param {string} [event.reason]
 * @param {Object} [event.partialRevoke] - Partial revoke selections
 * @param {Object} [event.accessInfo] - Current access info from review item
 * @returns {Promise<{ success: boolean, method: 'AUTOMATED'|'TICKET', actions?: string[] }>}
 */
const executeRevocation = async (event) => {
  const {
    resourceArn, resourceType, cycleId, ownerEmail,
    actorId, reason, userId, partialRevoke, accessInfo, accountId,
  } = event;
  const arn = resourceArn || userId;

  if (!arn || !cycleId) {
    console.error(JSON.stringify({
      errorCode: 'REVOCATION_MISSING_PARAMS',
      message: 'resourceArn and cycleId are required',
      timestamp: toISOString(new Date()),
    }));
    return { success: false, method: 'TICKET' };
  }

  // Route to the appropriate revocation executor based on resource type
  let executor = null;
  if (resourceType === 's3:bucket') {
    executor = executeS3Revocation;
  } else if (resourceType === 'iam:user') {
    executor = executeIamRevocation;
  }

  if (executor) {
    // Determine if cross-account credentials are needed
    let s3ClientOverride = null;
    let iamClientOverride = null;

    if (accountId && accountId !== MANAGEMENT_ACCOUNT_ID) {
      try {
        const credentials = await assumeCrossAccountRole(accountId, 'recert-processor');
        s3ClientOverride = new S3Client({ credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken } });
        iamClientOverride = new IAMClient({ credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken } });
      } catch (error) {
        console.error(JSON.stringify({
          errorCode: 'CROSS_ACCOUNT_REVOCATION_FAILED',
          message: error.message,
          accountId,
          resourceArn: arn,
          cycleId,
          function: 'revocation-handler',
          timestamp: toISOString(new Date()),
        }));
        // Fall back to ticket creation
        return await handleTicketFallback({
          arn, resourceType, cycleId, ownerEmail, actorId, reason,
        });
      }
    }

    return await executor({
      resourceArn: arn,
      resourceType,
      cycleId,
      ownerEmail,
      actorId,
      reason,
      partialRevoke,
      accessInfo,
      accountId,
      s3ClientOverride,
      iamClientOverride,
    });
  }

  // Unsupported type - fall back to ticket creation
  return await handleTicketFallback({
    arn, resourceType, cycleId, ownerEmail, actorId, reason,
  });
};

// State Snapshot 

/**
 * Capture and store the before-state of a resource's access configuration.
 * @param {Object} params
 * @param {string} params.resourceArn
 * @param {string} params.resourceType
 * @param {Object} params.beforeState - Full access configuration
 * @param {string} params.cycleId
 * @param {string} [params.partialRevoke]
 * @returns {Promise<{ snapshotSK: string, evidenceHash: string }>}
 */
const captureStateSnapshot = async ({ resourceArn, resourceType, beforeState, cycleId, partialRevoke, accountId }) => {
  const now = new Date();
  const timestamp = toISOString(now);
  const snapshotSK = `${SK_PREFIXES.REVOCATION_SNAPSHOT}${timestamp}`;
  const revocationType = partialRevoke ? 'PARTIAL' : 'FULL';

  const evidenceHash = computeEvidenceHash({
    userId: resourceArn,
    eventType: 'REVOCATION_SNAPSHOT',
    timestamp,
    metadata: { cycleId, resourceType, revocationType },
  });

  const item = {
    PK: `${KEY_PREFIXES.RESOURCE}${resourceArn}`,
    SK: snapshotSK,
    entityType: ENTITY_TYPES.REVOCATION_SNAPSHOT,
    cycleId,
    resourceArn,
    resourceType,
    beforeState,
    revocationType,
    evidenceHash,
    accountId: accountId || MANAGEMENT_ACCOUNT_ID,
    createdAt: timestamp,
    createdAtEpoch: toEpoch(now),
  };

  if (partialRevoke) {
    item.partialRevoke = partialRevoke;
  }

  await ddbClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  return { snapshotSK, evidenceHash };
};

// S3 Revocation 

/**
 * Execute S3 bucket revocation (full or partial).
 */
async function executeS3Revocation({ resourceArn, resourceType, cycleId, ownerEmail, actorId, reason, partialRevoke, accessInfo, accountId, s3ClientOverride }) {
  const bucket = extractBucketName(resourceArn);
  const s3 = s3ClientOverride || s3Client;

  try {
    // Gather current state for snapshot
    const beforeState = accessInfo || await fetchS3AccessState(bucket, s3);

    // Capture snapshot before modification
    const { snapshotSK, evidenceHash } = await captureStateSnapshot({
      resourceArn,
      resourceType,
      beforeState,
      cycleId,
      partialRevoke,
      accountId,
    });

    // Execute revocation
    const actions = partialRevoke
      ? await executeS3PartialRevocation(bucket, partialRevoke, beforeState, s3)
      : await executeS3FullRevocation(bucket, s3);

    // Log lifecycle event
    await logAutomatedRevocationEvent({
      resourceArn,
      resourceType,
      cycleId,
      ownerEmail,
      actorId,
      snapshotSK,
      actions,
      revocationType: partialRevoke ? 'PARTIAL' : 'FULL',
      accountId,
    });

    // Update review item status
    const status = partialRevoke ? 'PARTIAL_REVOKED' : 'REVOKED';
    await updateReviewItemStatus({ ownerEmail, cycleId, resourceArn, status });

    return { success: true, method: 'AUTOMATED', actions };
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'S3_REVOCATION_FAILED',
      resourceArn,
      cycleId,
      accountId: accountId || MANAGEMENT_ACCOUNT_ID,
      message: error.message,
      timestamp: toISOString(new Date()),
    }));

    await handleRevocationFailure({ arn: resourceArn, resourceType, cycleId, ownerEmail, actorId, reason, error });
    return { success: false, method: 'TICKET' };
  }
}

/** Full S3 revocation: delete policy, enable PAB, reset ACL to private. */
const executeS3FullRevocation = async (bucket, s3 = s3Client) => {
  const actions = [];

  await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
  actions.push('DeleteBucketPolicy');

  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  }));
  actions.push('PutPublicAccessBlock');

  await s3.send(new PutBucketAclCommand({
    Bucket: bucket,
    ACL: 'private',
  }));
  actions.push('PutBucketAcl');

  return actions;
};

/** Partial S3 revocation: remove only selected items. */
const executeS3PartialRevocation = async (bucket, partialRevoke, accessInfo, s3 = s3Client) => {
  const actions = [];

  // Handle policy statement removal
  if (partialRevoke.policyStatements && partialRevoke.policyStatements.length > 0 && accessInfo?.bucketPolicy) {
    const policy = accessInfo.bucketPolicy;
    const remainingStatements = (policy.Statement || []).filter(
      (stmt) => !partialRevoke.policyStatements.includes(stmt.Sid),
    );

    if (remainingStatements.length === 0) {
      await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
      actions.push('DeleteBucketPolicy');
    } else {
      const newPolicy = { ...policy, Statement: remainingStatements };
      await s3.send(new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify(newPolicy),
      }));
      actions.push('PutBucketPolicy');
    }
  }

  // Handle ACL grant removal
  if (partialRevoke.aclGrants && partialRevoke.aclGrants.length > 0 && accessInfo?.acl) {
    const acl = accessInfo.acl;
    const ownerGrant = acl.Grants?.find(
      (g) => g.Grantee?.ID === acl.Owner?.ID,
    );
    const remainingGrants = (acl.Grants || []).filter((grant) => {
      // Always preserve owner grant
      if (grant.Grantee?.ID === acl.Owner?.ID) return true;
      // Remove selected grants by grantee identifier (URI or ID)
      const granteeId = grant.Grantee?.URI || grant.Grantee?.ID || '';
      return !partialRevoke.aclGrants.includes(granteeId);
    });

    await s3.send(new PutBucketAclCommand({
      Bucket: bucket,
      AccessControlPolicy: {
        Owner: acl.Owner,
        Grants: remainingGrants,
      },
    }));
    actions.push('PutBucketAcl');
  }

  // Handle public access block enablement
  if (partialRevoke.enablePublicAccessBlock) {
    await s3.send(new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }));
    actions.push('PutPublicAccessBlock');
  }

  return actions;
};

// IAM Revocation 

/**
 * Execute IAM user revocation (full or partial).
 */
async function executeIamRevocation({ resourceArn, resourceType, cycleId, ownerEmail, actorId, reason, partialRevoke, accessInfo, accountId, iamClientOverride }) {
  const userName = extractIamUserName(resourceArn);
  const iam = iamClientOverride || iamClient;

  try {
    // Gather current state for snapshot
    const beforeState = accessInfo || await fetchIamAccessState(userName, iam);

    // Capture snapshot before modification
    const { snapshotSK, evidenceHash } = await captureStateSnapshot({
      resourceArn,
      resourceType,
      beforeState,
      cycleId,
      partialRevoke,
      accountId,
    });

    // Execute revocation
    const actions = partialRevoke
      ? await executeIamPartialRevocation(userName, partialRevoke, iam)
      : await executeIamFullRevocation(userName, beforeState, iam);

    // Log lifecycle event
    await logAutomatedRevocationEvent({
      resourceArn,
      resourceType,
      cycleId,
      ownerEmail,
      actorId,
      snapshotSK,
      actions,
      revocationType: partialRevoke ? 'PARTIAL' : 'FULL',
      accountId,
    });

    // Update review item status
    const status = partialRevoke ? 'PARTIAL_REVOKED' : 'REVOKED';
    await updateReviewItemStatus({ ownerEmail, cycleId, resourceArn, status });

    return { success: true, method: 'AUTOMATED', actions };
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'IAM_REVOCATION_FAILED',
      resourceArn,
      cycleId,
      accountId: accountId || MANAGEMENT_ACCOUNT_ID,
      message: error.message,
      timestamp: toISOString(new Date()),
    }));

    await handleRevocationFailure({ arn: resourceArn, resourceType, cycleId, ownerEmail, actorId, reason, error });
    return { success: false, method: 'TICKET' };
  }
}

/** Full IAM revocation: detach all policies, remove from all groups, deactivate all keys. */
const executeIamFullRevocation = async (userName, accessState, iam = iamClient) => {
  const actions = [];

  // Detach all managed policies
  const policies = accessState?.attachedPolicies || [];
  for (const policy of policies) {
    await iam.send(new DetachUserPolicyCommand({
      UserName: userName,
      PolicyArn: policy.PolicyArn,
    }));
    actions.push(`DetachUserPolicy:${policy.PolicyArn}`);
  }

  // Remove from all groups
  const groups = accessState?.groups || [];
  for (const group of groups) {
    await iam.send(new RemoveUserFromGroupCommand({
      UserName: userName,
      GroupName: group.GroupName,
    }));
    actions.push(`RemoveUserFromGroup:${group.GroupName}`);
  }

  // Deactivate all active access keys
  const accessKeys = accessState?.accessKeys || [];
  for (const key of accessKeys) {
    if (key.Status === 'Active') {
      await iam.send(new UpdateAccessKeyCommand({
        UserName: userName,
        AccessKeyId: key.AccessKeyId,
        Status: 'Inactive',
      }));
      actions.push(`DeactivateAccessKey:${key.AccessKeyId}`);
    }
  }

  return actions;
};

/** Partial IAM revocation: remove only selected items. */
const executeIamPartialRevocation = async (userName, partialRevoke, iam = iamClient) => {
  const actions = [];

  // Detach selected managed policies
  if (partialRevoke.managedPolicies && partialRevoke.managedPolicies.length > 0) {
    for (const policyArn of partialRevoke.managedPolicies) {
      await iam.send(new DetachUserPolicyCommand({
        UserName: userName,
        PolicyArn: policyArn,
      }));
      actions.push(`DetachUserPolicy:${policyArn}`);
    }
  }

  // Remove from selected groups
  if (partialRevoke.groups && partialRevoke.groups.length > 0) {
    for (const groupName of partialRevoke.groups) {
      await iam.send(new RemoveUserFromGroupCommand({
        UserName: userName,
        GroupName: groupName,
      }));
      actions.push(`RemoveUserFromGroup:${groupName}`);
    }
  }

  // Deactivate selected access keys
  if (partialRevoke.accessKeys && partialRevoke.accessKeys.length > 0) {
    for (const keyId of partialRevoke.accessKeys) {
      await iam.send(new UpdateAccessKeyCommand({
        UserName: userName,
        AccessKeyId: keyId,
        Status: 'Inactive',
      }));
      actions.push(`DeactivateAccessKey:${keyId}`);
    }
  }

  return actions;
};

// Ticket Fallback (unsupported types) 

const handleTicketFallback = async ({ arn, resourceType, cycleId, ownerEmail, actorId, reason }) => {
  const now = new Date();

  await createTicket({ arn, resourceType, cycleId, ownerEmail, actorId, reason, now });
  await logTicketCreatedEvent({ arn, resourceType, cycleId, ownerEmail, actorId, now });
  await sendConfirmationEmail({ arn, cycleId, ownerEmail });

  return { success: true, method: 'TICKET' };
};

// Shared Helpers 

/** Create a REVOCATION_TICKET record for IT admin review. */
const createTicket = async ({ arn, resourceType, cycleId, ownerEmail, actorId, reason, now }) => {
  await ddbClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `${KEY_PREFIXES.TYPE}REVOCATION_TICKET`,
      SK: `${toISOString(now)}#${arn}`,
      GSI1PK: `${KEY_PREFIXES.TYPE}REVOCATION_TICKET`,
      GSI1SK: toISOString(now),
      entityType: ENTITY_TYPES.REVOCATION_TICKET,
      resourceArn: arn,
      resourceType: resourceType || 'unknown',
      cycleId,
      ownerEmail: ownerEmail || '',
      actorId: actorId || 'SYSTEM',
      reason: reason || 'Access revoked during recertification',
      ticketStatus: 'OPEN',
      createdAt: toISOString(now),
      createdAtEpoch: toEpoch(now),
    },
  }));
};

/** Log ACCESS_REVOKED_TICKET_CREATED lifecycle event. */
const logTicketCreatedEvent = async ({ arn, resourceType, cycleId, ownerEmail, actorId, now }) => {
  const evidenceHash = computeEvidenceHash({
    userId: arn,
    eventType: 'ACCESS_REVOKED_TICKET_CREATED',
    timestamp: toISOString(now),
    metadata: { cycleId, ownerEmail },
  });

  try {
    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `${KEY_PREFIXES.RESOURCE}${arn}`,
        SK: `LIFECYCLE#${toISOString(now)}`,
        GSI1PK: `${KEY_PREFIXES.TYPE}ACCESS_REVOKED_TICKET_CREATED`,
        GSI1SK: toISOString(now),
        entityType: ENTITY_TYPES.LIFECYCLE_EVENT,
        resourceArn: arn,
        eventType: 'ACCESS_REVOKED_TICKET_CREATED',
        source: resourceType || 'unknown',
        actorId: actorId || 'SYSTEM',
        ownerEmail: ownerEmail || '',
        metadata: {
          triggeredBy: 'RECERTIFICATION',
          cycleId,
          ownerEmail,
          resourceType,
        },
        evidenceHash,
        createdAt: toISOString(now),
        createdAtEpoch: toEpoch(now),
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'REVOCATION_AUDIT_WRITE_FAILED',
      resourceArn: arn,
      cycleId,
      message: error.message,
      timestamp: toISOString(new Date()),
    }));
  }
};

/** Log ACCESS_REVOKED_AUTOMATED lifecycle event after successful automated revocation. */
const logAutomatedRevocationEvent = async ({ resourceArn, resourceType, cycleId, ownerEmail, actorId, snapshotSK, actions, revocationType, accountId }) => {
  const now = new Date();
  const timestamp = toISOString(now);

  const evidenceHash = computeEvidenceHash({
    userId: resourceArn,
    eventType: 'ACCESS_REVOKED_AUTOMATED',
    timestamp,
    metadata: { cycleId, ownerEmail, snapshotSK, revocationType },
  });

  try {
    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `${KEY_PREFIXES.RESOURCE}${resourceArn}`,
        SK: `LIFECYCLE#${timestamp}`,
        GSI1PK: `${KEY_PREFIXES.TYPE}ACCESS_REVOKED_AUTOMATED`,
        GSI1SK: timestamp,
        entityType: ENTITY_TYPES.LIFECYCLE_EVENT,
        resourceArn,
        eventType: 'ACCESS_REVOKED_AUTOMATED',
        source: resourceType || 'unknown',
        actorId: actorId || 'SYSTEM',
        ownerEmail: ownerEmail || '',
        accountId: accountId || MANAGEMENT_ACCOUNT_ID,
        metadata: {
          triggeredBy: 'RECERTIFICATION',
          cycleId,
          ownerEmail,
          resourceType,
          snapshotSK,
          actions,
          revocationType,
        },
        evidenceHash,
        createdAt: timestamp,
        createdAtEpoch: toEpoch(now),
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'REVOCATION_AUDIT_WRITE_FAILED',
      resourceArn,
      cycleId,
      message: error.message,
      timestamp: toISOString(new Date()),
    }));
  }
};

/** Send confirmation email to owner via recert-notifier. */
const sendConfirmationEmail = async ({ arn, cycleId, ownerEmail }) => {
  if (!ownerEmail) return;

  try {
    const functionName = process.env.RECERT_NOTIFIER_FUNCTION
      || `identity-governance-recert-notifier-${process.env.STAGE || 'dev'}`;

    await lambdaClient.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({
        action: 'REVOCATION_CONFIRMATION',
        cycleId,
        resourceArn: arn,
        resourceName: arn.split(':').pop() || arn,
        ownerEmail,
      }),
    }));
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'REVOCATION_CONFIRMATION_FAILED',
      resourceArn: arn,
      cycleId,
      message: error.message,
      timestamp: toISOString(new Date()),
    }));
  }
};

/** Handle revocation failure - create fallback ticket and update status. */
const handleRevocationFailure = async ({ arn, resourceType, cycleId, ownerEmail, actorId, reason, error }) => {
  const now = new Date();

  try {
    await createTicket({ arn, resourceType, cycleId, ownerEmail, actorId, reason, now });
  } catch (ticketError) {
    console.error(JSON.stringify({
      errorCode: 'FALLBACK_TICKET_FAILED',
      resourceArn: arn,
      cycleId,
      message: ticketError.message,
      timestamp: toISOString(new Date()),
    }));
  }

  await updateReviewItemStatus({ ownerEmail, cycleId, resourceArn: arn, status: 'REVOCATION_FAILED' });
};

/** Update review item status. */
const updateReviewItemStatus = async ({ ownerEmail, cycleId, resourceArn, status }) => {
  if (!ownerEmail) return;

  try {
    await ddbClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `${KEY_PREFIXES.OWNER}${ownerEmail}`,
        SK: `${SK_PREFIXES.RECERT_ITEM}${cycleId}#${resourceArn}`,
      },
      UpdateExpression: 'SET #s = :status',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':status': status },
    }));
  } catch (updateError) {
    console.error(JSON.stringify({
      errorCode: 'REVOCATION_STATUS_UPDATE_FAILED',
      resourceArn,
      cycleId,
      message: updateError.message,
      timestamp: toISOString(new Date()),
    }));
  }
};

/** Fetch current S3 access state for snapshot. */
const fetchS3AccessState = async (bucket, s3 = s3Client) => {
  let bucketPolicy = null;
  let publicAccessBlock = null;
  let acl = null;

  try {
    const policyResult = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    bucketPolicy = JSON.parse(policyResult.Policy);
  } catch (e) {
    if (e.name !== 'NoSuchBucketPolicy') throw e;
  }

  try {
    const pabResult = await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
    publicAccessBlock = pabResult.PublicAccessBlockConfiguration;
  } catch (e) {
    if (e.name !== 'NoSuchPublicAccessBlockConfiguration') throw e;
  }

  try {
    const aclResult = await s3.send(new GetBucketAclCommand({ Bucket: bucket }));
    acl = { Owner: aclResult.Owner, Grants: aclResult.Grants };
  } catch (e) {
    // ACL fetch failure is non-fatal for snapshot
  }

  return { bucketPolicy, publicAccessBlock, acl };
};

/** Fetch current IAM access state for snapshot. */
const fetchIamAccessState = async (userName, iam = iamClient) => {
  const [policiesResult, groupsResult, keysResult] = await Promise.all([
    iam.send(new ListAttachedUserPoliciesCommand({ UserName: userName })),
    iam.send(new ListGroupsForUserCommand({ UserName: userName })),
    iam.send(new ListAccessKeysCommand({ UserName: userName })),
  ]);

  return {
    attachedPolicies: policiesResult.AttachedPolicies || [],
    groups: (groupsResult.Groups || []).map((g) => ({ GroupName: g.GroupName })),
    accessKeys: (keysResult.AccessKeyMetadata || []).map((k) => ({
      AccessKeyId: k.AccessKeyId,
      Status: k.Status,
      CreateDate: k.CreateDate?.toISOString?.() || k.CreateDate,
    })),
  };
};

/** Extract bucket name from S3 ARN. */
const extractBucketName = (arn) => {
  // arn:aws:s3:::bucket-name or just bucket-name
  if (arn.startsWith('arn:')) {
    return arn.split(':::')[1]?.split('/')[0] || arn;
  }
  return arn;
};

/** Extract IAM user name from ARN. */
const extractIamUserName = (arn) => {
  // arn:aws:iam::123456789012:user/username or just username
  if (arn.startsWith('arn:')) {
    return arn.split('/').pop() || arn;
  }
  return arn;
};

// Per-User Revocation 

/**
 * Execute per-user revocation targeting a specific principal's access to a resource.
 * Routes to the appropriate revocation method based on accessSource.
 * @param {Object} event
 * @param {string} event.resourceArn - Resource ARN (S3 bucket)
 * @param {string} event.principalArn - Principal to revoke
 * @param {string} event.accessSource - How the principal gains access (BUCKET_POLICY, IAM_POLICY, IAM_GROUP, ACL)
 * @param {string} event.cycleId
 * @param {string} event.ownerEmail
 * @param {string} [event.actorId]
 * @param {string} [event.reason]
 * @param {Object} [event.accessInfo] - Current access info from review item
 * @returns {Promise<{ success: boolean, method: 'AUTOMATED'|'TICKET', actions: string[] }>}
 */
export const executeUserRevocation = async (event) => {
  const { resourceArn, principalArn, accessSource, cycleId, ownerEmail, actorId, reason, accessInfo } = event;

  if (!resourceArn || !principalArn || !cycleId) {
    console.error(JSON.stringify({
      errorCode: 'USER_REVOCATION_MISSING_PARAMS',
      message: 'resourceArn, principalArn, and cycleId are required',
      function: 'revocation-handler',
      timestamp: toISOString(new Date()),
    }));
    return { success: false, method: 'TICKET', actions: [] };
  }

  const bucket = extractBucketName(resourceArn);

  try {
    // Capture before-state snapshot
    const beforeState = accessInfo || await fetchS3AccessState(bucket);
    await captureStateSnapshot({
      resourceArn,
      resourceType: 's3:bucket',
      beforeState,
      cycleId,
      partialRevoke: null,
    });

    let actions = [];

    if (accessSource === 'BUCKET_POLICY' || (accessSource === 'IAM_POLICY' && beforeState?.bucketPolicy)) {
      actions = await revokeFromBucketPolicy(bucket, principalArn, beforeState);
    }

    if (accessSource === 'IAM_POLICY' || accessSource === 'IAM_GROUP') {
      const iamActions = await revokeIamAccess(principalArn, accessSource);
      actions = actions.concat(iamActions);
    }

    if (accessSource === 'ACL') {
      const aclActions = await revokeFromAcl(bucket, principalArn, beforeState);
      actions = actions.concat(aclActions);
    }

    // Log ACCESS_REVOKED_AUTOMATED lifecycle event with principalArn
    await logUserRevocationEvent({ resourceArn, principalArn, cycleId, ownerEmail, actorId, actions });

    return { success: true, method: 'AUTOMATED', actions };
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'USER_REVOCATION_FAILED',
      resourceArn,
      principalArn,
      cycleId,
      message: error.message,
      function: 'revocation-handler',
      timestamp: toISOString(new Date()),
    }));

    // Create fallback ticket
    await createUserRevocationTicket({ resourceArn, principalArn, cycleId, ownerEmail, actorId, reason, error });
    return { success: false, method: 'TICKET', actions: [] };
  }
};

/**
 * Remove a specific principal from S3 bucket policy statements.
 * If a statement has no principals left, remove the statement.
 * If no statements remain, delete the bucket policy.
 */
const revokeFromBucketPolicy = async (bucket, principalArn, beforeState) => {
  const actions = [];
  let policy = beforeState?.bucketPolicy;

  if (!policy) {
    try {
      const result = await s3Client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
      policy = result.Policy ? JSON.parse(result.Policy) : null;
    } catch (error) {
      if (error.name === 'NoSuchBucketPolicy') return actions;
      throw error;
    }
  }

  if (!policy || !policy.Statement) return actions;

  const modifiedStatements = [];

  for (const statement of policy.Statement) {
    const principal = statement.Principal;
    if (!principal) {
      modifiedStatements.push(statement);
      continue;
    }

    // Check if this principal appears in the statement
    const removedFromStatement = removePrincipalFromStatement(statement, principalArn);
    if (removedFromStatement === null) {
      // Statement had only this principal - remove entire statement
      continue;
    }
    modifiedStatements.push(removedFromStatement);
  }

  if (modifiedStatements.length === 0) {
    // No statements remain - delete the bucket policy
    await s3Client.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
    actions.push('DeleteBucketPolicy');
  } else if (modifiedStatements.length < policy.Statement.length || statementsModified(policy.Statement, modifiedStatements)) {
    // Put modified policy back
    const newPolicy = { ...policy, Statement: modifiedStatements };
    await s3Client.send(new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify(newPolicy),
    }));
    actions.push('PutBucketPolicy');
  }

  return actions;
};

/**
 * Remove a principal from a policy statement's Principal field.
 * Returns the modified statement, or null if the statement should be removed entirely.
 */
const removePrincipalFromStatement = (statement, principalArn) => {
  const principal = statement.Principal;
  if (!principal) return statement;

  // Handle string principal
  if (typeof principal === 'string') {
    if (principal === principalArn) return null;
    return statement;
  }

  // Handle Principal.AWS
  if (principal.AWS) {
    const awsPrincipals = Array.isArray(principal.AWS) ? principal.AWS : [principal.AWS];
    const filtered = awsPrincipals.filter((p) => p !== principalArn);

    if (filtered.length === awsPrincipals.length) {
      // Principal not found in this statement
      return statement;
    }

    if (filtered.length === 0 && !principal.Service) {
      // No principals left in this statement
      return null;
    }

    const newPrincipal = { ...principal };
    if (filtered.length === 0) {
      delete newPrincipal.AWS;
    } else if (filtered.length === 1) {
      newPrincipal.AWS = filtered[0];
    } else {
      newPrincipal.AWS = filtered;
    }

    return { ...statement, Principal: newPrincipal };
  }

  return statement;
};

/**
 * Check if statements were modified (principal removed but statement still exists).
 */
const statementsModified = (original, modified) => {
  return JSON.stringify(original) !== JSON.stringify(modified);
};

/**
 * Revoke IAM access for a principal.
 * For IAM_GROUP: remove user from all groups.
 * For IAM_POLICY: detach all attached policies from the user.
 */
const revokeIamAccess = async (principalArn, accessSource) => {
  const actions = [];
  const userName = extractIamUserName(principalArn);

  if (accessSource === 'IAM_GROUP') {
    // Remove user from all groups
    try {
      const groupsResult = await iamClient.send(new ListGroupsForUserCommand({ UserName: userName }));
      for (const group of (groupsResult.Groups || [])) {
        await iamClient.send(new RemoveUserFromGroupCommand({
          UserName: userName,
          GroupName: group.GroupName,
        }));
        actions.push(`RemoveUserFromGroup:${group.GroupName}`);
      }
    } catch (error) {
      if (error.name !== 'NoSuchEntity' && error.name !== 'NoSuchEntityException') throw error;
      // User already deleted - treat as success
    }
  } else {
    // IAM_POLICY: detach all attached policies
    try {
      const policiesResult = await iamClient.send(new ListAttachedUserPoliciesCommand({ UserName: userName }));
      for (const policy of (policiesResult.AttachedPolicies || [])) {
        await iamClient.send(new DetachUserPolicyCommand({
          UserName: userName,
          PolicyArn: policy.PolicyArn,
        }));
        actions.push(`DetachUserPolicy:${policy.PolicyArn}`);
      }
    } catch (error) {
      if (error.name !== 'NoSuchEntity' && error.name !== 'NoSuchEntityException') throw error;
    }
  }

  return actions;
};

/**
 * Remove a specific grantee from S3 bucket ACL.
 * Preserves owner FULL_CONTROL and all other grantees.
 */
const revokeFromAcl = async (bucket, principalArn, beforeState) => {
  const actions = [];
  let acl = beforeState?.acl;

  if (!acl) {
    try {
      const result = await s3Client.send(new GetBucketAclCommand({ Bucket: bucket }));
      acl = { Owner: result.Owner, Grants: result.Grants || [] };
    } catch (error) {
      throw error;
    }
  }

  if (!acl || !acl.Grants) return actions;

  // Filter out grants for the target principal, always preserve owner FULL_CONTROL
  const remainingGrants = acl.Grants.filter((grant) => {
    // Always preserve owner's FULL_CONTROL
    if (grant.Grantee?.ID === acl.Owner?.ID && grant.Permission === 'FULL_CONTROL') {
      return true;
    }
    // Remove grants matching the target principal
    const granteeId = grant.Grantee?.ID || grant.Grantee?.URI || '';
    const granteeCanonical = grant.Grantee?.ID || '';
    // Match by canonical user ID or by ARN pattern
    if (granteeId === principalArn || granteeCanonical === principalArn) {
      return false;
    }
    // Check if the ARN matches (e.g., arn:aws:iam::123456789012:user/alice)
    if (principalArn.includes(granteeId) || granteeId.includes(principalArn)) {
      return false;
    }
    return true;
  });

  // Ensure owner FULL_CONTROL is always present
  const hasOwnerFullControl = remainingGrants.some(
    (g) => g.Grantee?.ID === acl.Owner?.ID && g.Permission === 'FULL_CONTROL',
  );
  if (!hasOwnerFullControl && acl.Owner?.ID) {
    remainingGrants.unshift({
      Grantee: { ID: acl.Owner.ID, Type: 'CanonicalUser' },
      Permission: 'FULL_CONTROL',
    });
  }

  await s3Client.send(new PutBucketAclCommand({
    Bucket: bucket,
    AccessControlPolicy: {
      Owner: acl.Owner,
      Grants: remainingGrants,
    },
  }));
  actions.push('PutBucketAcl');

  return actions;
};

/**
 * Log ACCESS_REVOKED_AUTOMATED lifecycle event with principalArn in metadata.
 */
const logUserRevocationEvent = async ({ resourceArn, principalArn, cycleId, ownerEmail, actorId, actions }) => {
  const now = new Date();
  const timestamp = toISOString(now);

  const evidenceHash = computeEvidenceHash({
    userId: resourceArn,
    eventType: 'ACCESS_REVOKED_AUTOMATED',
    timestamp,
    metadata: { cycleId, ownerEmail, principalArn },
  });

  try {
    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `${KEY_PREFIXES.RESOURCE}${resourceArn}`,
        SK: `LIFECYCLE#${timestamp}#${principalArn}`,
        GSI1PK: `${KEY_PREFIXES.TYPE}ACCESS_REVOKED_AUTOMATED`,
        GSI1SK: timestamp,
        entityType: ENTITY_TYPES.LIFECYCLE_EVENT,
        resourceArn,
        eventType: 'ACCESS_REVOKED_AUTOMATED',
        source: 's3:bucket',
        actorId: actorId || 'SYSTEM',
        ownerEmail: ownerEmail || '',
        metadata: {
          triggeredBy: 'RECERTIFICATION',
          cycleId,
          ownerEmail,
          principalArn,
          actions,
          revocationType: 'PER_USER',
        },
        evidenceHash,
        createdAt: timestamp,
        createdAtEpoch: toEpoch(now),
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'USER_REVOCATION_AUDIT_WRITE_FAILED',
      resourceArn,
      principalArn,
      cycleId,
      message: error.message,
      function: 'revocation-handler',
      timestamp: toISOString(new Date()),
    }));
  }
};

/**
 * Create a fallback revocation ticket when per-user revocation fails.
 */
const createUserRevocationTicket = async ({ resourceArn, principalArn, cycleId, ownerEmail, actorId, reason, error }) => {
  const now = new Date();

  try {
    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `${KEY_PREFIXES.TYPE}REVOCATION_TICKET`,
        SK: `${toISOString(now)}#${resourceArn}#${principalArn}`,
        GSI1PK: `${KEY_PREFIXES.TYPE}REVOCATION_TICKET`,
        GSI1SK: toISOString(now),
        entityType: ENTITY_TYPES.REVOCATION_TICKET,
        resourceArn,
        principalArn,
        resourceType: 's3:bucket',
        cycleId,
        ownerEmail: ownerEmail || '',
        actorId: actorId || 'SYSTEM',
        reason: reason || 'Per-user access revocation failed',
        failureReason: error?.message || 'Unknown error',
        ticketStatus: 'OPEN',
        createdAt: toISOString(now),
        createdAtEpoch: toEpoch(now),
      },
    }));
  } catch (ticketError) {
    console.error(JSON.stringify({
      errorCode: 'USER_REVOCATION_TICKET_FAILED',
      resourceArn,
      principalArn,
      cycleId,
      message: ticketError.message,
      function: 'revocation-handler',
      timestamp: toISOString(new Date()),
    }));
  }
};

export default executeRevocation;
export { captureStateSnapshot, executeS3Revocation, executeIamRevocation, SUPPORTED_REVOCATION_TYPES, maskAccessKeyId };

/**
 * Mask an access key ID, showing only the last 4 characters.
 * @param {string} keyId
 * @returns {string}
 */
function maskAccessKeyId(keyId) {
  if (!keyId || keyId.length < 4) return keyId || '';
  return '*'.repeat(keyId.length - 4) + keyId.slice(-4);
}
