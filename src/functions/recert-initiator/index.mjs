/**
 * Recert Initiator Lambda - AWS resource-centric, owner-driven recertification.
 * Discovers AWS resources (S3, EC2, Lambda, etc.) via Resource Groups Tagging API,
 * extracts owner from tags, collates by owner email, creates review items per owner.
 * @module functions/recert-initiator
 */

import { PutCommand, QueryCommand, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ResourceGroupsTaggingAPIClient, GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import { S3Client, GetBucketPolicyCommand, GetPublicAccessBlockCommand, GetBucketAclCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
import { IAMClient, ListUsersCommand, ListAttachedUserPoliciesCommand, ListUserPoliciesCommand, ListGroupsForUserCommand, ListAccessKeysCommand } from '@aws-sdk/client-iam';
import { OrganizationsClient, ListAccountsCommand } from '@aws-sdk/client-organizations';
import { discoverAccess } from './access-discovery.mjs';
import { assumeCrossAccountRole } from '../../shared/cross-account-credentials.mjs';
import { ddbClient, TABLE_NAME } from '../../shared/dynamo-client.mjs';
import { toISOString, toEpoch } from '../../shared/time-utils.mjs';
import {
  successResponse, errorResponse,
  KEY_PREFIXES, SK_PREFIXES, ENTITY_TYPES, RESOURCE_TYPES,
} from '../../shared/constants.mjs';

const DEADLINE_DAYS = parseInt(process.env.RECERT_DEADLINE_DAYS || '14', 10);
const DEFAULT_REVIEWER_EMAIL = process.env.DEFAULT_REVIEWER_EMAIL || '';
const MANAGEMENT_ACCOUNT_ID = process.env.MANAGEMENT_ACCOUNT_ID || '364170696417';
const lambdaClient = new LambdaClient({});
const taggingClient = new ResourceGroupsTaggingAPIClient({});
const s3Client = new S3Client({});
const iamClient = new IAMClient({});
const orgsClient = new OrganizationsClient({});

// Router 

export const handler = async (event) => {
  try {
    if (event.httpMethod) return await routeApiRequest(event);
    return await initiateCycle({ cycleType: 'QUARTERLY' });
  } catch (error) {
    logError('RECERT_INITIATOR_ERROR', error);
    if (event.httpMethod) return errorResponse(500, 'Internal server error');
  }
};

const routeApiRequest = async (event) => {
  const { httpMethod, path } = event;
  if (httpMethod === 'POST' && path?.endsWith('/recert/cycles')) return await handleManualCycleTrigger(event);
  if (httpMethod === 'POST' && path?.includes('/admin/accounts/sync')) return await handleSyncAccounts();
  if (httpMethod === 'POST' && path?.includes('/admin/accounts/') && path?.includes('/scan')) return await handleAccountScan(event);
  if (httpMethod === 'POST' && path?.includes('/admin/overrides')) return await handleCreateOverride(event);
  if (httpMethod === 'GET' && path?.includes('/admin/unowned')) return await handleGetUnowned();
  if (httpMethod === 'DELETE' && path?.includes('/admin/overrides')) return await handleDeleteOverride(event);
  if (httpMethod === 'GET' && path?.includes('/admin/overrides')) return await handleGetOverrides();
  if (httpMethod === 'GET' && path?.includes('/admin/accounts')) return await handleGetAccounts();
  return errorResponse(404, 'Not found');
};

// Admin Override Handlers 

const handleCreateOverride = async (event) => {
  const body = JSON.parse(event.body || '{}');
  const { ownerEmail, resources } = body;
  if (!ownerEmail || !Array.isArray(resources) || resources.length === 0) {
    return errorResponse(400, 'ownerEmail and resources[] are required');
  }

  const callerSub = event.requestContext?.authorizer?.claims?.sub || 'admin';
  const now = new Date();
  const results = [];

  for (const res of resources) {
    try {
      await ddbClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `${KEY_PREFIXES.OVERRIDE}${ownerEmail}`,
          SK: `RESOURCE#${res.resourceArn || res.userId}`,
          entityType: ENTITY_TYPES.OWNER_OVERRIDE,
          ownerEmail,
          resourceArn: res.resourceArn || res.userId,
          resourceType: res.resourceType || 'unknown',
          reason: res.reason || 'Admin override',
          assignedAt: toISOString(now),
          assignedBy: callerSub,
          status: 'ACTIVE',
          createdAt: toISOString(now),
          createdAtEpoch: toEpoch(now),
        },
      }));
      results.push({ resourceArn: res.resourceArn || res.userId, status: 'ASSIGNED' });
    } catch (error) {
      results.push({ resourceArn: res.resourceArn || res.userId, status: 'FAILED', error: error.message });
    }
  }

  // Refresh unowned cache: remove assigned resources
  try {
    const cached = await ddbClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: 'CACHE#UNOWNED', SK: 'LATEST' },
    }));
    if (cached.Item && cached.Item.resources) {
      const assignedArns = new Set(resources.map((r) => r.resourceArn || r.userId));
      const updatedResources = cached.Item.resources.filter((r) => !assignedArns.has(r.arn));
      await ddbClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...cached.Item,
          resources: updatedResources,
          count: updatedResources.length,
        },
      }));
    }
  } catch (cacheErr) {
    logError('CACHE_UPDATE_AFTER_ASSIGN_FAILED', cacheErr);
  }

  // Create review items for the active cycle immediately
  const activeCycleId = generateCycleId(now);
  const deadline = new Date(now.getTime() + DEADLINE_DAYS * 24 * 60 * 60 * 1000);
  for (const res of resources) {
    const arn = res.resourceArn || res.userId;
    try {
      await ddbClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `${KEY_PREFIXES.OWNER}${ownerEmail}`,
          SK: `${SK_PREFIXES.RECERT_ITEM}${activeCycleId}#${arn}`,
          GSI1PK: `${KEY_PREFIXES.TYPE}RECERT_ITEM`,
          GSI1SK: `${activeCycleId}#PENDING`,
          entityType: ENTITY_TYPES.RECERT_ITEM,
          cycleId: activeCycleId,
          resourceArn: arn,
          resourceType: res.resourceType || 'unknown',
          resourceName: arn.split(':').pop() || arn,
          service: (res.resourceType || '').split(':')[0] || 'unknown',
          ownerEmail,
          status: 'PENDING',
          decision: null,
          decisionReason: null,
          decisionComment: null,
          decisionTimestamp: null,
          decisionActorId: null,
          onBehalfOf: null,
          deadline: toISOString(deadline),
          createdAt: toISOString(now),
          createdAtEpoch: toEpoch(now),
          accountId: '364170696417',
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
    } catch (reviewErr) {
      // Ignore ConditionalCheckFailed (already exists)
      if (reviewErr.name !== 'ConditionalCheckFailedException') {
        logError('REVIEW_ITEM_CREATE_ON_ASSIGN_FAILED', reviewErr, { arn, ownerEmail });
      }
    }
  }

  return successResponse(200, { ownerEmail, overrides: results });
};

const handleGetOverrides = async () => {
  const items = await scanByEntityType(ENTITY_TYPES.OWNER_OVERRIDE, 'ACTIVE');
  const grouped = {};
  for (const item of items) {
    if (!grouped[item.ownerEmail]) grouped[item.ownerEmail] = { ownerEmail: item.ownerEmail, resources: [] };
    grouped[item.ownerEmail].resources.push(item);
  }
  return successResponse(200, { overrides: Object.values(grouped) });
};

const handleGetUnowned = async () => {
  // Read from DynamoDB cache (populated by nightly stats-aggregator sync)
  try {
    const cached = await ddbClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: 'CACHE#UNOWNED', SK: 'LATEST' },
    }));
    if (cached.Item) {
      return successResponse(200, {
        unownedResources: cached.Item.resources || [],
        lastSyncedAt: cached.Item.createdAt || null,
        count: cached.Item.count || 0,
      });
    }
  } catch (err) {
    logError('CACHE_READ_FAILED', err);
  }

  // Fallback: live discovery if cache not yet populated
  const allResources = await discoverAllResourcesUnfiltered();
  const unowned = allResources.filter((r) => !r.ownerEmail);
  return successResponse(200, { unownedResources: unowned, lastSyncedAt: null, count: unowned.length });
};

const handleDeleteOverride = async (event) => {
  const { ownerEmail, userId } = event.pathParameters || {};
  if (!ownerEmail || !userId) return errorResponse(400, 'ownerEmail and userId are required');
  const callerSub = event.requestContext?.authorizer?.claims?.sub || 'admin';
  const now = new Date();

  await ddbClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `${KEY_PREFIXES.OVERRIDE}${ownerEmail}`, SK: `RESOURCE#${userId}` },
    UpdateExpression: 'SET #s = :removed, removedAt = :now, removedBy = :by',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':removed': 'REMOVED', ':now': toISOString(now), ':by': callerSub },
  }));
  return successResponse(200, { ownerEmail, userId, status: 'REMOVED' });
};

// Account Discovery Handlers 

const handleGetAccounts = async () => {
  const items = [];
  let lastKey;
  do {
    const result = await ddbClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :et',
      ExpressionAttributeValues: { ':et': ENTITY_TYPES.ACCOUNT },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  const accounts = items.map((item) => ({
    accountId: item.accountId,
    accountName: item.accountName,
    email: item.email,
    status: item.status,
    lastSyncedAt: item.lastSyncedAt || null,
  }));
  return successResponse(200, { accounts });
};

const handleSyncAccounts = async () => {
  const discoveredAccounts = [];
  let nextToken;

  do {
    const params = {};
    if (nextToken) params.NextToken = nextToken;
    const result = await orgsClient.send(new ListAccountsCommand(params));
    discoveredAccounts.push(...(result.Accounts || []));
    nextToken = result.NextToken;
  } while (nextToken);

  const now = new Date();

  // Load existing accounts from DynamoDB
  const existingAccounts = await loadExistingAccounts();
  const discoveredIds = new Set(discoveredAccounts.map((a) => a.Id));

  // Upsert discovered accounts
  for (const account of discoveredAccounts) {
    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `${KEY_PREFIXES.ACCOUNT}${account.Id}`,
        SK: 'METADATA',
        entityType: ENTITY_TYPES.ACCOUNT,
        accountId: account.Id,
        accountName: account.Name || '',
        email: account.Email || '',
        status: account.Status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED',
        joinedTimestamp: account.JoinedTimestamp ? toISOString(account.JoinedTimestamp) : null,
        lastSyncedAt: toISOString(now),
        createdAt: toISOString(now),
        createdAtEpoch: toEpoch(now),
      },
    }));
  }

  // Mark missing accounts as SUSPENDED
  for (const existing of existingAccounts) {
    if (!discoveredIds.has(existing.accountId) && existing.status === 'ACTIVE') {
      await ddbClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `${KEY_PREFIXES.ACCOUNT}${existing.accountId}`, SK: 'METADATA' },
        UpdateExpression: 'SET #s = :suspended, lastSyncedAt = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':suspended': 'SUSPENDED', ':now': toISOString(now) },
      }));
    }
  }

  const accounts = discoveredAccounts.map((a) => ({
    accountId: a.Id,
    accountName: a.Name || '',
    email: a.Email || '',
    status: a.Status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED',
  }));
  return successResponse(200, { accounts, syncedAt: toISOString(now) });
};

const handleAccountScan = async (event) => {
  const accountId = event.pathParameters?.accountId;
  if (!accountId) return errorResponse(400, 'accountId is required');

  let credentials;
  try {
    credentials = await assumeCrossAccountRole(accountId, 'recert-initiator');
  } catch (error) {
    return errorResponse(400, `Cross-account role assumption failed for account ${accountId}. Ensure VIGILCrossAccountRole is deployed.`);
  }

  const crossAccountTaggingClient = new ResourceGroupsTaggingAPIClient({ credentials });
  const resources = [];
  let paginationToken;

  do {
    const params = { ResourcesPerPage: 100 };
    if (paginationToken) params.PaginationToken = paginationToken;

    const result = await crossAccountTaggingClient.send(new GetResourcesCommand(params));
    for (const mapping of (result.ResourceTagMappingList || [])) {
      const parsed = parseResourceArn(mapping.ResourceARN);
      const ownerTag = (mapping.Tags || []).find((t) => t.Key === 'owner');

      resources.push({
        arn: mapping.ResourceARN,
        service: parsed.service,
        resourceType: `${parsed.service}:${parsed.resourceType}`,
        resourceId: parsed.resourceId,
        ownerEmail: ownerTag?.Value || '',
        accountId,
      });
    }
    paginationToken = result.PaginationToken;
  } while (paginationToken);

  return successResponse(200, { accountId, resources, count: resources.length });
};

const loadExistingAccounts = async () => {
  const items = [];
  let lastKey;
  do {
    const result = await ddbClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :et',
      ExpressionAttributeValues: { ':et': ENTITY_TYPES.ACCOUNT },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
};

// Manual Cycle Trigger 

const handleManualCycleTrigger = async (event) => {
  const body = JSON.parse(event.body || '{}');
  const { cycleType = 'AD_HOC', scope, deadline } = body;

  if (cycleType === 'AD_HOC') {
    const cycleId = `${new Date().getFullYear()}-ADHOC-${Date.now()}`;
    const validScopes = ['ALL', 'OWNER', 'RESOURCES'];
    const scopeType = scope?.type || 'ALL';
    if (!validScopes.includes(scopeType)) return errorResponse(400, `scope.type must be one of: ${validScopes.join(', ')}`);
    if (scopeType === 'OWNER' && !scope?.ownerEmail) return errorResponse(400, 'scope.ownerEmail is required for OWNER scope');
    if (scopeType === 'RESOURCES' && (!Array.isArray(scope?.resourceArns) || scope.resourceArns.length === 0)) {
      return errorResponse(400, 'scope.resourceArns[] is required for RESOURCES scope');
    }
    const result = await initiateCycle({ cycleType: 'AD_HOC', cycleId, scope, deadline });
    return successResponse(200, result);
  }
  const result = await initiateCycle({ cycleType: 'QUARTERLY' });
  return successResponse(200, result);
};

// Cycle Initiation 

const initiateCycle = async ({ cycleType = 'QUARTERLY', cycleId, scope, deadline }) => {
  const now = new Date();
  const id = cycleId || generateCycleId(now);

  const existing = await ddbClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `${KEY_PREFIXES.CYCLE}${id}`, SK: SK_PREFIXES.SUMMARY },
  }));
  if (existing.Item) return { cycleId: id, status: 'ALREADY_EXISTS', totalResources: existing.Item.totalResources || 0, totalOwners: existing.Item.totalOwners || 0, totalUnownedResources: existing.Item.totalUnownedResources || 0 };

  const allResources = await discoverAllResources(scope);
  if (allResources.length === 0) return { cycleId: id, status: 'NO_RESOURCES' };

  const overrides = await loadOverrides();
  const ownerMap = collateByOwner(allResources, overrides, scope);

  const deadlineDate = deadline
    ? new Date(deadline)
    : new Date(now.getTime() + DEADLINE_DAYS * 24 * 60 * 60 * 1000);

  const counts = { total: 0, unowned: 0, byService: {} };

  // Enrich override resources (that weren't discovered via Tagging API) with access entries
  const iamUsersForOverrides = await listIamUsers();
  for (const [, resources] of Object.entries(ownerMap)) {
    for (const resource of resources) {
      if (!resource.accessEntries && resource.arn && iamUsersForOverrides.length > 0) {
        try {
          const accessEntries = await discoverAccess(resource.arn, iamUsersForOverrides, {
            startTime: now.getTime(),
            resourceType: resource.resourceType,
          });
          resource.accessEntries = accessEntries;
          resource.discoveryStatus = 'COMPLETE';
        } catch (err) {
          logError('OVERRIDE_RESOURCE_DISCOVERY_FAILED', err, { arn: resource.arn });
        }
      }
    }
  }

  for (const [ownerEmail, resources] of Object.entries(ownerMap)) {
    for (const resource of resources) {
      await createReviewItem(id, ownerEmail, resource, deadlineDate, now);
      counts.total++;
      if (resource.isUnowned) counts.unowned++;
      counts.byService[resource.service] = (counts.byService[resource.service] || 0) + 1;
    }
  }

  await writeCycleSummary(id, cycleType, ownerMap, counts, deadlineDate, scope, now);
  await triggerNotifier(id, 'INITIAL');

  return {
    cycleId: id, status: 'INITIATED',
    totalResources: counts.total,
    totalOwners: Object.keys(ownerMap).length,
    totalUnownedResources: counts.unowned,
  };
};

// Active Account Helper 

/**
 * Query Account Registry for all accounts with status ACTIVE.
 * @returns {Promise<Array<{accountId: string, accountName: string, email: string, status: string}>>}
 */
const getActiveAccounts = async () => {
  const items = [];
  let lastKey;
  do {
    const result = await ddbClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :et AND #s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':et': ENTITY_TYPES.ACCOUNT, ':active': 'ACTIVE' },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items.map((item) => ({
    accountId: item.accountId,
    accountName: item.accountName || '',
    email: item.email || '',
    status: item.status,
  }));
};

// Resource Discovery via Tagging API 

/**
 * Discover ALL resources in the account (no tag filter) to find unowned ones.
 * Only fetches basic info - no enrichment.
 */
const discoverAllResourcesUnfiltered = async () => {
  const resources = [];
  let paginationToken;

  do {
    const params = { ResourcesPerPage: 100 };
    if (paginationToken) params.PaginationToken = paginationToken;

    try {
      const result = await taggingClient.send(new GetResourcesCommand(params));
      for (const mapping of (result.ResourceTagMappingList || [])) {
        const parsed = parseResourceArn(mapping.ResourceARN);
        const ownerTag = (mapping.Tags || []).find((t) => t.Key === 'owner');
        const tags = tagsToMap(mapping.Tags || []);

        resources.push({
          arn: mapping.ResourceARN,
          service: parsed.service,
          resourceType: `${parsed.service}:${parsed.resourceType}`,
          resourceId: parsed.resourceId,
          resourceName: parsed.resourceId,
          region: parsed.region,
          ownerEmail: ownerTag?.Value || '',
          tags,
        });
      }
      paginationToken = result.PaginationToken;
    } catch (error) {
      logError('UNFILTERED_DISCOVERY_FAILED', error);
      break;
    }
  } while (paginationToken);

  return resources;
};

const discoverAllResources = async (scope) => {
  const resources = [];

  if (scope && scope.accountId) {
    // Scoped to a single account
    if (scope.accountId === MANAGEMENT_ACCOUNT_ID) {
      const mgmtResources = await discoverResourcesInAccount(taggingClient, MANAGEMENT_ACCOUNT_ID, 'Management');
      resources.push(...mgmtResources);
    } else {
      try {
        const credentials = await assumeCrossAccountRole(scope.accountId, 'recert-initiator');
        const crossAccountClient = new ResourceGroupsTaggingAPIClient({ credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken } });
        const accountResources = await discoverResourcesInAccount(crossAccountClient, scope.accountId, scope.accountName || '');
        resources.push(...accountResources);
      } catch (error) {
        logError('CROSS_ACCOUNT_ASSUME_ROLE_FAILED', error, { accountId: scope.accountId });
      }
    }
  } else {
    // Iterate all active accounts + management account
    const activeAccounts = await getActiveAccounts();

    // Process member accounts sequentially (Task 5.7)
    for (const account of activeAccounts) {
      if (account.accountId === MANAGEMENT_ACCOUNT_ID) continue; // handled separately below
      try {
        const credentials = await assumeCrossAccountRole(account.accountId, 'recert-initiator');
        const crossAccountClient = new ResourceGroupsTaggingAPIClient({ credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken } });
        const accountResources = await discoverResourcesInAccount(crossAccountClient, account.accountId, account.accountName);
        resources.push(...accountResources);
      } catch (error) {
        logError('CROSS_ACCOUNT_ASSUME_ROLE_FAILED', error, { accountId: account.accountId });
        // Continue to next account (fail-forward)
      }
    }

    // Management account resources (no AssumeRole needed) - Task 5.5
    const mgmtResources = await discoverResourcesInAccount(taggingClient, MANAGEMENT_ACCOUNT_ID, 'Management');
    resources.push(...mgmtResources);
  }

  await enrichS3Resources(resources);
  await enrichWithAccessDiscovery(resources);
  await enrichIamResources(resources);
  return resources;
};

/**
 * Discover tagged resources in a single account using the provided Tagging API client.
 * @param {ResourceGroupsTaggingAPIClient} client - Tagging API client (default or cross-account)
 * @param {string} accountId - Account ID to tag on each resource
 * @param {string} accountName - Account name to tag on each resource
 * @returns {Promise<Array>}
 */
const discoverResourcesInAccount = async (client, accountId, accountName) => {
  const resources = [];
  let paginationToken;

  do {
    const params = {
      TagFilters: [{ Key: 'owner' }],
      ResourcesPerPage: 100,
    };
    if (paginationToken) params.PaginationToken = paginationToken;

    try {
      const result = await client.send(new GetResourcesCommand(params));
      for (const mapping of (result.ResourceTagMappingList || [])) {
        const parsed = parseResourceArn(mapping.ResourceARN);
        const ownerTag = (mapping.Tags || []).find((t) => t.Key === 'owner');
        const tags = tagsToMap(mapping.Tags || []);

        resources.push({
          arn: mapping.ResourceARN,
          service: parsed.service,
          resourceType: `${parsed.service}:${parsed.resourceType}`,
          resourceId: parsed.resourceId,
          resourceName: parsed.resourceId,
          region: parsed.region,
          ownerEmail: ownerTag?.Value || '',
          tags,
          accountId,
          accountName,
        });
      }
      paginationToken = result.PaginationToken;
    } catch (error) {
      logError('RESOURCE_DISCOVERY_FAILED', error, { accountId });
      break;
    }
  } while (paginationToken);

  return resources;
};

const parseResourceArn = (arn) => {
  // arn:aws:service:region:account:resourceType/resourceId
  // arn:aws:s3:::bucket-name
  const parts = (arn || '').split(':');
  const service = parts[2] || 'unknown';
  const region = parts[3] || '';
  const resourcePart = parts.slice(5).join(':');

  let resourceType = 'resource';
  let resourceId = resourcePart;

  if (service === 's3') {
    resourceType = 'bucket';
    resourceId = resourcePart;
  } else if (resourcePart.includes('/')) {
    const [type, ...rest] = resourcePart.split('/');
    resourceType = type || 'resource';
    resourceId = rest.join('/');
  } else if (resourcePart.includes(':')) {
    const [type, ...rest] = resourcePart.split(':');
    resourceType = type || 'resource';
    resourceId = rest.join(':');
  }

  return { service, region, resourceType, resourceId };
};

const tagsToMap = (tags) => {
  const map = {};
  for (const t of tags) map[t.Key] = t.Value;
  return map;
};

const enrichS3Resources = async (resources) => {
  const s3Resources = resources.filter((r) => r.service === 's3');
  for (const r of s3Resources) {
    const accessInfo = { bucketPolicy: null, publicAccessBlock: null, acl: null };

    accessInfo.bucketPolicy = await fetchBucketPolicy(r.resourceId);
    accessInfo.publicAccessBlock = await fetchPublicAccessBlock(r.resourceId);
    accessInfo.acl = await fetchBucketAcl(r.resourceId);

    r.accessInfo = accessInfo;
  }
};

const fetchBucketPolicy = async (bucket) => {
  try {
    const result = await s3Client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    return result.Policy ? JSON.parse(result.Policy) : null;
  } catch (error) {
    if (error.name === 'NoSuchBucketPolicy') return null;
    logError('S3_ACCESS_DETAIL_FAILED', error, { bucket, api: 'GetBucketPolicy' });
    return null;
  }
};

const fetchPublicAccessBlock = async (bucket) => {
  try {
    const result = await s3Client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
    return result.PublicAccessBlockConfiguration || null;
  } catch (error) {
    if (error.name === 'NoSuchPublicAccessBlockConfiguration') return null;
    logError('S3_ACCESS_DETAIL_FAILED', error, { bucket, api: 'GetPublicAccessBlock' });
    return null;
  }
};

const fetchBucketAcl = async (bucket) => {
  try {
    const result = await s3Client.send(new GetBucketAclCommand({ Bucket: bucket }));
    return { Owner: result.Owner || null, Grants: result.Grants || [] };
  } catch (error) {
    logError('S3_ACCESS_DETAIL_FAILED', error, { bucket, api: 'GetBucketAcl' });
    return null;
  }
};

// Access Discovery Enrichment 

const listIamUsers = async () => {
  const users = [];
  let marker;

  do {
    try {
      const result = await iamClient.send(new ListUsersCommand({ Marker: marker, MaxItems: 100 }));
      for (const user of (result.Users || [])) {
        users.push({ arn: user.Arn, userName: user.UserName });
      }
      marker = result.IsTruncated ? result.Marker : undefined;
    } catch (error) {
      logError('IAM_LIST_USERS_FAILED', error);
      break;
    }
  } while (marker);

  return users;
};

const enrichWithAccessDiscovery = async (resources) => {
  // Run access discovery for ALL resource types (not just S3)
  const discoverable = resources.filter((r) => r.arn);
  if (discoverable.length === 0) return;

  const iamUsers = await listIamUsers();
  if (iamUsers.length === 0) return;

  const startTime = Date.now();

  for (const r of discoverable) {
    // Timeout guard
    if (Date.now() - startTime > 270000) {
      r.discoveryStatus = 'PARTIAL';
      continue;
    }

    // For cross-account resources, obtain credentials for access discovery
    let credentials = null;
    if (r.accountId && r.accountId !== MANAGEMENT_ACCOUNT_ID) {
      try {
        credentials = await assumeCrossAccountRole(r.accountId, 'recert-initiator');
      } catch (error) {
        logError('CROSS_ACCOUNT_ASSUME_ROLE_FAILED', error, { accountId: r.accountId, phase: 'access-discovery' });
        r.discoveryStatus = 'SKIPPED';
        continue;
      }
    }

    const accessEntries = await discoverAccess(r.arn, iamUsers, {
      startTime,
      accessInfo: r.accessInfo,
      credentials,
      resourceType: r.resourceType,
    });

    r.accessEntries = accessEntries;
    r.discoveryStatus = accessEntries.length === 0 && (Date.now() - startTime > 280000)
      ? 'PARTIAL'
      : 'COMPLETE';
  }
};

// IAM Access Detail Enrichment 

const enrichIamResources = async (resources) => {
  const iamResources = resources.filter((r) => r.resourceType === 'iam:user');
  for (const r of iamResources) {
    const accessInfo = { attachedPolicies: null, inlinePolicies: null, groups: null, accessKeys: null };

    accessInfo.attachedPolicies = await fetchAttachedUserPolicies(r.resourceId);
    accessInfo.inlinePolicies = await fetchInlineUserPolicies(r.resourceId);
    accessInfo.groups = await fetchGroupsForUser(r.resourceId);
    accessInfo.accessKeys = await fetchAccessKeys(r.resourceId);

    r.accessInfo = accessInfo;
  }
};

const fetchAttachedUserPolicies = async (userName) => {
  try {
    const result = await iamClient.send(new ListAttachedUserPoliciesCommand({ UserName: userName }));
    return (result.AttachedPolicies || []).map((p) => ({ PolicyArn: p.PolicyArn, PolicyName: p.PolicyName }));
  } catch (error) {
    logError('IAM_ACCESS_DETAIL_FAILED', error, { userName, api: 'ListAttachedUserPolicies' });
    return null;
  }
};

const fetchInlineUserPolicies = async (userName) => {
  try {
    const result = await iamClient.send(new ListUserPoliciesCommand({ UserName: userName }));
    return result.PolicyNames || [];
  } catch (error) {
    logError('IAM_ACCESS_DETAIL_FAILED', error, { userName, api: 'ListUserPolicies' });
    return null;
  }
};

const fetchGroupsForUser = async (userName) => {
  try {
    const result = await iamClient.send(new ListGroupsForUserCommand({ UserName: userName }));
    return (result.Groups || []).map((g) => ({ GroupName: g.GroupName }));
  } catch (error) {
    logError('IAM_ACCESS_DETAIL_FAILED', error, { userName, api: 'ListGroupsForUser' });
    return null;
  }
};

const fetchAccessKeys = async (userName) => {
  try {
    const result = await iamClient.send(new ListAccessKeysCommand({ UserName: userName }));
    return (result.AccessKeyMetadata || []).map((k) => ({
      AccessKeyId: k.AccessKeyId,
      Status: k.Status,
      CreateDate: k.CreateDate ? k.CreateDate.toISOString() : null,
    }));
  } catch (error) {
    logError('IAM_ACCESS_DETAIL_FAILED', error, { userName, api: 'ListAccessKeys' });
    return null;
  }
};

// Owner Collation 

const collateByOwner = (resources, overrides, scope) => {
  const ownerMap = {};
  const discoveredArns = new Set(resources.map((r) => r.arn));

  for (const resource of resources) {
    if (scope) {
      if (scope.type === 'OWNER' && scope.ownerEmail && resource.ownerEmail !== scope.ownerEmail) continue;
      if (scope.type === 'RESOURCES' && Array.isArray(scope.resourceArns) && !scope.resourceArns.includes(resource.arn)) continue;
    }

    let ownerEmail = resource.ownerEmail;
    let isUnowned = false;

    if (!ownerEmail) {
      const overrideOwner = findOverrideOwner(resource.arn, overrides);
      if (overrideOwner) {
        ownerEmail = overrideOwner;
      } else if (DEFAULT_REVIEWER_EMAIL) {
        ownerEmail = DEFAULT_REVIEWER_EMAIL;
        isUnowned = true;
      } else {
        continue;
      }
    }

    if (!ownerMap[ownerEmail]) ownerMap[ownerEmail] = [];
    ownerMap[ownerEmail].push({ ...resource, ownerEmail, isUnowned });
  }

  // Add override resources that weren't discovered by Tagging API
  for (const override of overrides) {
    if (override.status !== 'ACTIVE') continue;
    const arn = override.resourceArn || override.userId;
    if (discoveredArns.has(arn)) continue; // Already included

    if (scope) {
      if (scope.type === 'OWNER' && scope.ownerEmail && override.ownerEmail !== scope.ownerEmail) continue;
      if (scope.type === 'RESOURCES' && Array.isArray(scope.resourceArns) && !scope.resourceArns.includes(arn)) continue;
    }

    const ownerEmail = override.ownerEmail;
    if (!ownerEmail) continue;

    // Parse ARN to determine resource type
    const parsed = parseResourceArn(arn);
    const resource = {
      arn,
      service: parsed.service,
      resourceType: `${parsed.service}:${parsed.resourceType}`,
      resourceId: parsed.resourceId,
      resourceName: parsed.resourceId,
      region: parsed.region,
      ownerEmail,
      tags: {},
      accountId: MANAGEMENT_ACCOUNT_ID,
      isUnowned: false,
    };

    if (!ownerMap[ownerEmail]) ownerMap[ownerEmail] = [];
    ownerMap[ownerEmail].push(resource);
  }

  return ownerMap;
};

const findOverrideOwner = (arn, overrides) => {
  for (const override of overrides) {
    if ((override.resourceArn === arn || override.userId === arn) && override.status === 'ACTIVE') {
      return override.ownerEmail;
    }
  }
  return null;
};

// Review Item Creation 

const createReviewItem = async (cycleId, ownerEmail, resource, deadline, now) => {
  await ddbClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `${KEY_PREFIXES.OWNER}${ownerEmail}`,
      SK: `${SK_PREFIXES.RECERT_ITEM}${cycleId}#${resource.arn}`,
      GSI1PK: `${KEY_PREFIXES.TYPE}RECERT_ITEM`,
      GSI1SK: `${cycleId}#PENDING`,
      entityType: ENTITY_TYPES.RECERT_ITEM,
      cycleId,
      resourceArn: resource.arn,
      resourceType: resource.resourceType,
      resourceName: resource.resourceName,
      service: resource.service,
      region: resource.region || '',
      tags: resource.tags || {},
      accessInfo: resource.accessInfo || null,
      accessEntries: resource.accessEntries || null,
      discoveryStatus: resource.discoveryStatus || null,
      ownerEmail,
      accountId: resource.accountId || MANAGEMENT_ACCOUNT_ID,
      accountName: resource.accountName || '',
      status: 'PENDING',
      decision: null,
      decisionReason: null,
      decisionComment: null,
      decisionTimestamp: null,
      decisionActorId: null,
      onBehalfOf: null,
      deadline: toISOString(deadline),
      createdAt: toISOString(now),
      createdAtEpoch: toEpoch(now),
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
};

// Cycle Summary 

const writeCycleSummary = async (id, cycleType, ownerMap, counts, deadlineDate, scope, now) => {
  await ddbClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `${KEY_PREFIXES.CYCLE}${id}`,
      SK: SK_PREFIXES.SUMMARY,
      entityType: ENTITY_TYPES.RECERT_CYCLE,
      cycleId: id,
      cycleType,
      status: 'ACTIVE',
      startDate: toISOString(now),
      deadline: toISOString(deadlineDate),
      totalResources: counts.total,
      totalOwners: Object.keys(ownerMap).length,
      totalUnownedResources: counts.unowned,
      resourcesByService: counts.byService,
      completedCount: 0,
      certifiedCount: 0,
      revokedCount: 0,
      modifiedCount: 0,
      completionPercentage: 0,
      scope: scope || null,
      createdAt: toISOString(now),
      createdAtEpoch: toEpoch(now),
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
};

// Shared Helpers 

const generateCycleId = (date) => {
  const year = date.getFullYear();
  const quarter = Math.ceil((date.getMonth() + 1) / 3);
  return `${year}-Q${quarter}`;
};

const loadOverrides = async () => scanByEntityType(ENTITY_TYPES.OWNER_OVERRIDE, 'ACTIVE');

const scanByEntityType = async (entityType, status) => {
  const items = [];
  let lastKey;
  do {
    const result = await ddbClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :et AND #s = :active',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':et': entityType, ':active': status },
      ExclusiveStartKey: lastKey,
    }));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
};

const triggerNotifier = async (cycleId, action) => {
  try {
    const functionName = process.env.RECERT_NOTIFIER_FUNCTION
      || `identity-governance-recert-notifier-${process.env.STAGE || 'dev'}`;
    await lambdaClient.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: JSON.stringify({ action, cycleId }),
    }));
  } catch (error) {
    logError('NOTIFIER_TRIGGER_FAILED', error, { cycleId, action });
  }
};

const logError = (errorCode, error, extra = {}) => {
  console.error(JSON.stringify({
    errorCode,
    message: error.message,
    function: 'recert-initiator',
    ...extra,
    timestamp: toISOString(new Date()),
  }));
};
