/**
 * Stats Aggregator Lambda - scheduled daily via EventBridge (18:30 UTC).
 * Computes and caches dashboard statistics in DynamoDB (STATS#DAILY, {date}).
 * Pulls live user counts from identity sources (Cognito, IAM, Identity Center)
 * and combines with DynamoDB event data.
 * @module functions/stats-aggregator
 */

import { QueryCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ResourceGroupsTaggingAPIClient, GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import { ddbClient, TABLE_NAME } from '../../shared/dynamo-client.mjs';
import { toISOString, toIST, toEpoch } from '../../shared/time-utils.mjs';
import {
  KEY_PREFIXES,
  EVENT_TYPES,
  IDENTITY_SOURCES,
  ENTITY_TYPES,
  SK_PREFIXES,
} from '../../shared/constants.mjs';
import { getAdapter } from '../../shared/identity-adapters/index.mjs';
import { assumeCrossAccountRole } from '../../shared/cross-account-credentials.mjs';

const FUNCTION_NAME = 'stats-aggregator';
const MANAGEMENT_ACCOUNT_ID = process.env.MANAGEMENT_ACCOUNT_ID || '364170696417';
const taggingClient = new ResourceGroupsTaggingAPIClient({});

/**
 * Structured error log entry.
 * @param {string} errorCode
 * @param {string} message
 */
const logError = (errorCode, message) => {
  console.error(JSON.stringify({
    errorCode,
    message,
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
 * Main handler - triggered by EventBridge Scheduler daily at 18:30 UTC and 00:00 UTC.
 * @param {object} event - EventBridge scheduled event
 * @returns {void}
 */
export const handler = async (event) => {
  const today = toISOString(new Date()).slice(0, 10);
  logInfo('STATS_AGGREGATION_START', { date: today });

  try {
    const stats = await computeAllStats(today);
    await writeDailyStats(today, stats);

    // Cache unowned resources and full resource list
    await cacheResourceData();

    logInfo('STATS_AGGREGATION_COMPLETE', { date: today, totalUsers: stats.totalUsers });
  } catch (error) {
    logError('STATS_AGGREGATION_FAILED', error.message);
    throw error;
  }
};

/**
 * Compute all dashboard statistics for the given date.
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<object>}
 */
export const computeAllStats = async (date) => {
  const [usersBySource, eventCounts, activityCounts, creationsByMonth] = await Promise.all([
    countUsersBySource(),
    countEventsByType(date),
    countActiveUsers(date),
    countCreationsByMonth(),
  ]);

  const totalUsers = sumObjectValues(usersBySource);
  const usersByStatus = deriveUsersByStatus(usersBySource, activityCounts);

  return {
    totalUsers,
    usersBySource,
    usersByStatus,
    activeToday: activityCounts.activeToday,
    activeThisWeek: activityCounts.activeThisWeek,
    inactive90Days: activityCounts.inactive90Days,
    eventCounts,
    creationsByMonth,
    recertDecisionBreakdown: await countRecertDecisions(),
  };
};

// User counts by source (GSI2) 

/** Identity sources to count */
const SOURCES_TO_COUNT = [
  IDENTITY_SOURCES.COGNITO,
  IDENTITY_SOURCES.JIT,
  IDENTITY_SOURCES.IAM,
  IDENTITY_SOURCES.IDENTITY_CENTER,
  IDENTITY_SOURCES.SCIM,
];

/**
 * Count total users by identity source using live adapter queries.
 * Falls back to GSI2 counts if adapter fails.
 * @returns {Promise<object>} Map of source -> count
 */
export const countUsersBySource = async () => {
  const counts = {};

  for (const source of SOURCES_TO_COUNT) {
    try {
      const adapter = getAdapter(source);
      const users = await adapter.listUsers();
      if (users.length > 0) counts[source] = users.length;
    } catch {
      // Fallback to GSI2 count if adapter fails (e.g. Identity Center not configured)
      const gsiCount = await countSourceUsers(source);
      if (gsiCount > 0) counts[source] = gsiCount;
    }
  }

  return counts;
};

/**
 * Count users for a single identity source via GSI2.
 * Uses Select: 'COUNT' to avoid reading full items.
 * @param {string} source
 * @returns {Promise<number>}
 */
export const countSourceUsers = async (source) => {
  let total = 0;
  let lastKey = null;

  do {
    const params = {
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :gsi2pk',
      ExpressionAttributeValues: {
        ':gsi2pk': `${KEY_PREFIXES.SOURCE}${source}`,
      },
      Select: 'COUNT',
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;

    const result = await ddbClient.send(new QueryCommand(params));
    total += result.Count || 0;
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  return total;
};

// Event counts by type (GSI1) 

/**
 * Count events by type for a specific date using GSI1 (TYPE#{eventType}).
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<object>} Map of eventType -> count
 */
export const countEventsByType = async (date) => {
  const startOfDay = `${date}T00:00:00.000Z`;
  const endOfDay = `${date}T23:59:59.999Z`;
  const eventTypes = Object.values(EVENT_TYPES);

  const queries = eventTypes.map((type) => countEventsForType(type, startOfDay, endOfDay));
  const results = await Promise.all(queries);

  const counts = {};
  eventTypes.forEach((type, i) => {
    counts[type] = results[i];
  });

  return counts;
};

/**
 * Count events for a single event type within a date range via GSI1.
 * @param {string} eventType
 * @param {string} startTime - ISO timestamp
 * @param {string} endTime - ISO timestamp
 * @returns {Promise<number>}
 */
export const countEventsForType = async (eventType, startTime, endTime) => {
  let total = 0;
  let lastKey = null;

  do {
    const params = {
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :gsi1pk AND GSI1SK BETWEEN :start AND :end',
      ExpressionAttributeValues: {
        ':gsi1pk': `${KEY_PREFIXES.TYPE}${eventType}`,
        ':start': startTime,
        ':end': endTime,
      },
      Select: 'COUNT',
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;

    const result = await ddbClient.send(new QueryCommand(params));
    total += result.Count || 0;
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  return total;
};

// Active user counts 

/**
 * Count active users: today, this week, and 90+ days inactive.
 * Scans ACTIVITY_DAILY# records to determine activity.
 * @param {string} date - YYYY-MM-DD (today)
 * @returns {Promise<{ activeToday: number, activeThisWeek: number, inactive90Days: number }>}
 */
export const countActiveUsers = async (date) => {
  const today = date;
  const weekAgo = computePastDate(date, 7);
  const ninetyDaysAgo = computePastDate(date, 90);

  const activeToday = await countActivityRecordsForDate(today);
  const activeThisWeek = await countActivityRecordsInRange(weekAgo, today);
  const inactive90Days = await countInactiveUsers(ninetyDaysAgo);

  return { activeToday, activeThisWeek, inactive90Days };
};

/**
 * Count distinct users with ACTIVITY_DAILY records for a specific date.
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<number>}
 */
export const countActivityRecordsForDate = async (date) => {
  const userIds = new Set();
  let lastKey = null;

  do {
    const params = {
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :et AND #d = :date',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: {
        ':et': ENTITY_TYPES.ACTIVITY_DAILY,
        ':date': date,
      },
      ProjectionExpression: 'userId',
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;

    const result = await ddbClient.send(new ScanCommand(params));
    (result.Items || []).forEach((item) => userIds.add(item.userId));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  return userIds.size;
};

/**
 * Count distinct users with ACTIVITY_DAILY records in a date range.
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {Promise<number>}
 */
export const countActivityRecordsInRange = async (startDate, endDate) => {
  const userIds = new Set();
  let lastKey = null;

  do {
    const params = {
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :et AND #d BETWEEN :start AND :end',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: {
        ':et': ENTITY_TYPES.ACTIVITY_DAILY,
        ':start': startDate,
        ':end': endDate,
      },
      ProjectionExpression: 'userId',
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;

    const result = await ddbClient.send(new ScanCommand(params));
    (result.Items || []).forEach((item) => userIds.add(item.userId));
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  return userIds.size;
};

/**
 * Count users with no ACTIVITY_DAILY record in the last 90 days.
 * Compares total users from GSI2 against users active in last 90 days.
 * @param {string} ninetyDaysAgo - YYYY-MM-DD
 * @returns {Promise<number>}
 */
export const countInactiveUsers = async (ninetyDaysAgo) => {
  const today = toISOString(new Date()).slice(0, 10);
  const totalUsers = await countTotalUsersFromSource();
  const activeIn90Days = await countActivityRecordsInRange(ninetyDaysAgo, today);
  return Math.max(0, totalUsers - activeIn90Days);
};

/**
 * Count total users across all identity sources.
 * @returns {Promise<number>}
 */
const countTotalUsersFromSource = async () => {
  const counts = await countUsersBySource();
  return sumObjectValues(counts);
};

// Creations by month 

/**
 * Count user creations by month for the last 12 months using GSI1.
 * @returns {Promise<object>} Map of YYYY-MM -> count
 */
export const countCreationsByMonth = async () => {
  const now = new Date();
  const months = {};

  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const startOfMonth = `${monthKey}-01T00:00:00.000Z`;
    const endOfMonth = computeEndOfMonth(d);
    months[monthKey] = await countEventsForType(EVENT_TYPES.CREATED, startOfMonth, endOfMonth);
  }

  return months;
};

/**
 * Compute end-of-month ISO timestamp.
 * @param {Date} date - Any date in the target month
 * @returns {string} ISO timestamp for last moment of the month
 */
export const computeEndOfMonth = (date) => {
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const monthKey = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, '0')}`;
  return `${monthKey}-${String(lastDay.getDate()).padStart(2, '0')}T23:59:59.999Z`;
};

// Recertification decisions 

/** Recert decision types to count */
const RECERT_DECISIONS = ['CERTIFIED', 'REVOKED', 'MODIFIED', 'PENDING'];

/**
 * Count recertification decisions from the latest cycle.
 * Scans for RECERT_DECISION entities and tallies by decision type.
 * @returns {Promise<object|null>} Map of decision -> count, or null if no data
 */
export const countRecertDecisions = async () => {
  const counts = {};
  let found = false;
  let lastKey = null;

  do {
    const params = {
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :et',
      ExpressionAttributeValues: {
        ':et': ENTITY_TYPES.RECERT_DECISION,
      },
      ProjectionExpression: 'decision',
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;

    const result = await ddbClient.send(new ScanCommand(params));
    for (const item of result.Items || []) {
      const decision = item.decision || 'PENDING';
      counts[decision] = (counts[decision] || 0) + 1;
      found = true;
    }
    lastKey = result.LastEvaluatedKey || null;
  } while (lastKey);

  if (!found) return null;

  // Ensure all decision types are present
  for (const d of RECERT_DECISIONS) {
    if (!counts[d]) counts[d] = 0;
  }

  return counts;
};

// Write stats to DynamoDB (Task 8.2) 

/**
 * Write aggregated stats to DynamoDB. Overwrites existing record for the same date.
 * PK: STATS#DAILY, SK: {date}
 * @param {string} date - YYYY-MM-DD
 * @param {object} stats - Computed statistics
 * @returns {Promise<void>}
 */
export const writeDailyStats = async (date, stats) => {
  const now = new Date();
  const item = {
    PK: KEY_PREFIXES.STATS_DAILY,
    SK: date,
    entityType: 'STATS_DAILY',
    ...stats,
    createdAt: toISOString(now),
    createdAtEpoch: toEpoch(now),
    createdAtIST: toIST(now),
  };

  await ddbClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
  }));
  logInfo('STATS_WRITTEN', { date });
};

// Utility helpers 

/**
 * Sum all numeric values in an object.
 * @param {object} obj
 * @returns {number}
 */
export const sumObjectValues = (obj) => {
  return Object.values(obj).reduce((sum, val) => sum + (val || 0), 0);
};

/**
 * Derive user status counts from source counts and activity data.
 * ASSUMPTION: Without per-user status tracking, we estimate based on
 * total users minus deleted/disabled events. For MVP, returns a
 * simplified breakdown.
 * @param {object} usersBySource
 * @param {object} activityCounts
 * @returns {object}
 */
export const deriveUsersByStatus = (usersBySource, activityCounts) => {
  const total = sumObjectValues(usersBySource);
  const inactive = activityCounts.inactive90Days || 0;
  const active = Math.max(0, total - inactive);

  return {
    ACTIVE: active,
    INACTIVE: inactive,
  };
};

/**
 * Compute a date N days in the past from a reference date.
 * @param {string} date - YYYY-MM-DD reference date
 * @param {number} days - Number of days to go back
 * @returns {string} YYYY-MM-DD
 */
export const computePastDate = (date, days) => {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return toISOString(d).slice(0, 10);
};

// Resource Cache (Nightly Sync) 

/**
 * Query Account Registry for all accounts with status ACTIVE.
 * @returns {Promise<Array<{accountId: string, accountName: string, email: string, status: string}>>}
 */
const getActiveAccountsForSync = async () => {
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

/**
 * Discover all resources via Tagging API and cache unowned + full list in DynamoDB.
 * Iterates all active accounts for multi-account support.
 * PK=CACHE#UNOWNED, SK=LATEST and PK=CACHE#RESOURCES, SK=LATEST
 * @returns {Promise<void>}
 */
const cacheResourceData = async () => {
  try {
    const allResources = [];
    const accountStats = [];
    const activeAccounts = await getActiveAccountsForSync();

    // Process member accounts sequentially
    for (const account of activeAccounts) {
      if (account.accountId === MANAGEMENT_ACCOUNT_ID) continue;
      try {
        const credentials = await assumeCrossAccountRole(account.accountId, 'stats-aggregator');
        const crossAccountClient = new ResourceGroupsTaggingAPIClient({ credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken } });
        const accountResources = await discoverResourcesForAccount(crossAccountClient, account.accountId, account.accountName);
        allResources.push(...accountResources);
        accountStats.push({ accountId: account.accountId, accountName: account.accountName, resourceCount: accountResources.length, lastSyncedAt: toISOString(new Date()) });

        // Update lastSyncedAt on account record (Task 8.5)
        await updateAccountLastSyncedAt(account.accountId);
      } catch (error) {
        logError('CROSS_ACCOUNT_CACHE_FAILED', `Account ${account.accountId}: ${error.message}`);
        accountStats.push({ accountId: account.accountId, accountName: account.accountName, resourceCount: 0, lastSyncedAt: null, error: error.message });
        // Continue to next account
      }
    }

    // Management account resources (no AssumeRole needed)
    const mgmtResources = await discoverResourcesForAccount(taggingClient, MANAGEMENT_ACCOUNT_ID, 'Management');
    allResources.push(...mgmtResources);
    accountStats.push({ accountId: MANAGEMENT_ACCOUNT_ID, accountName: 'Management', resourceCount: mgmtResources.length, lastSyncedAt: toISOString(new Date()) });

    const unowned = allResources.filter((r) => !r.ownerEmail);
    const now = new Date();

    // Cache unowned resources
    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: 'CACHE#UNOWNED',
        SK: 'LATEST',
        entityType: 'CACHE',
        resources: unowned,
        count: unowned.length,
        createdAt: toISOString(now),
        createdAtEpoch: toEpoch(now),
      },
    }));

    // Cache full resource list (truncate to avoid 400KB DynamoDB item limit)
    const resourceSummaries = allResources.slice(0, 500).map((r) => ({
      arn: r.arn,
      service: r.service,
      resourceType: r.resourceType,
      resourceName: r.resourceName,
      ownerEmail: r.ownerEmail,
      region: r.region,
      accountId: r.accountId,
    }));

    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: 'CACHE#RESOURCES',
        SK: 'LATEST',
        entityType: 'CACHE',
        resources: resourceSummaries,
        count: allResources.length,
        createdAt: toISOString(now),
        createdAtEpoch: toEpoch(now),
      },
    }));

    // Store per-account stats (Task 8.4)
    await ddbClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: 'CACHE#ACCOUNT_STATS',
        SK: 'LATEST',
        entityType: 'CACHE',
        accounts: accountStats,
        totalResources: allResources.length,
        createdAt: toISOString(now),
        createdAtEpoch: toEpoch(now),
      },
    }));

    logInfo('RESOURCE_CACHE_WRITTEN', { total: allResources.length, unowned: unowned.length, accountsProcessed: accountStats.length });
  } catch (err) {
    logError('RESOURCE_CACHE_FAILED', err.message);
  }
};

/**
 * Discover all resources in a single account via Tagging API.
 * @param {ResourceGroupsTaggingAPIClient} client - Tagging API client
 * @param {string} accountId - Account ID to tag on each resource
 * @param {string} accountName - Account name to tag on each resource
 * @returns {Promise<Array>}
 */
const discoverResourcesForAccount = async (client, accountId, accountName) => {
  const resources = [];
  let paginationToken;

  do {
    const params = { ResourcesPerPage: 100 };
    if (paginationToken) params.PaginationToken = paginationToken;

    try {
      const result = await client.send(new GetResourcesCommand(params));
      for (const mapping of (result.ResourceTagMappingList || [])) {
        const arn = mapping.ResourceARN;
        const parts = (arn || '').split(':');
        const service = parts[2] || 'unknown';
        const region = parts[3] || '';
        const resourcePart = parts.slice(5).join(':');
        const ownerTag = (mapping.Tags || []).find((t) => t.Key === 'owner');

        let resourceId = resourcePart;
        if (resourcePart.includes('/')) {
          resourceId = resourcePart.split('/').pop();
        }

        resources.push({
          arn,
          service,
          resourceType: `${service}:${resourcePart.split('/')[0] || 'resource'}`,
          resourceName: resourceId,
          region,
          ownerEmail: ownerTag?.Value || '',
          accountId,
          accountName,
          tags: (mapping.Tags || []).reduce((m, t) => { m[t.Key] = t.Value; return m; }, {}),
        });
      }
      paginationToken = result.PaginationToken;
    } catch (err) {
      logError('CACHE_DISCOVERY_FAILED', `Account ${accountId}: ${err.message}`);
      break;
    }
  } while (paginationToken);

  return resources;
};

/**
 * Update lastSyncedAt on an account's DynamoDB record.
 * @param {string} accountId
 * @returns {Promise<void>}
 */
const updateAccountLastSyncedAt = async (accountId) => {
  try {
    await ddbClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `${KEY_PREFIXES.ACCOUNT}${accountId}`, SK: 'METADATA' },
      UpdateExpression: 'SET lastSyncedAt = :now',
      ExpressionAttributeValues: { ':now': toISOString(new Date()) },
    }));
  } catch (error) {
    logError('ACCOUNT_SYNC_UPDATE_FAILED', `Account ${accountId}: ${error.message}`);
  }
};
