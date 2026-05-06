/**
 * CloudTrail Access Analyzer - queries CloudTrail LookupEvents to determine
 * which principals have accessed a resource in the last 90 days.
 * Aggregates events by principal with lastAccessed, firstAccessed, accessCount, and eventNames.
 * @module functions/recert-initiator/cloudtrail-analyzer
 */

import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';

const cloudTrailClient = new CloudTrailClient({});

const LOOKBACK_DAYS = 90;
const MAX_RESULTS_PER_PAGE = 50;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

// Helpers 

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isThrottleError = (error) => {
  const name = error.name || error.Code || '';
  return name === 'ThrottlingException' || name === 'Throttling' || name === 'TooManyRequestsException';
};

/**
 * Extract principal name from ARN (last segment after / or :).
 * @param {string} arn
 * @returns {string}
 */
const extractPrincipalName = (arn) => {
  if (!arn) return 'unknown';
  // Handle ARNs like arn:aws:iam::123456789012:user/alice
  // or arn:aws:sts::123456789012:assumed-role/RoleName/session
  const slashIndex = arn.lastIndexOf('/');
  if (slashIndex !== -1) return arn.substring(slashIndex + 1);
  const colonIndex = arn.lastIndexOf(':');
  if (colonIndex !== -1) return arn.substring(colonIndex + 1);
  return arn;
};

// Retry with Exponential Backoff 

const lookupEventsWithRetry = async (params, client, retryCount = 0) => {
  try {
    const result = await client.send(new LookupEventsCommand(params));
    return result;
  } catch (error) {
    if (isThrottleError(error) && retryCount < MAX_RETRIES) {
      const delay = BASE_BACKOFF_MS * Math.pow(2, retryCount);
      console.error(JSON.stringify({
        errorCode: 'CLOUDTRAIL_THROTTLE_RETRY',
        message: `Retry ${retryCount + 1}/${MAX_RETRIES} after ${delay}ms`,
        function: 'cloudtrail-analyzer',
        timestamp: new Date().toISOString(),
      }));
      await sleep(delay);
      return lookupEventsWithRetry(params, client, retryCount + 1);
    }
    throw error;
  }
};

// Main Export 

/**
 * Query CloudTrail for access history on a resource.
 * @param {string} resourceArn - S3 bucket ARN (used as ResourceName filter)
 * @param {object} [credentials] - Optional cross-account credentials {accessKeyId, secretAccessKey, sessionToken}
 * @returns {Promise<AccessHistoryEntry[]>}
 */
export const getAccessHistory = async (resourceArn, credentials) => {
  const clientToUse = credentials
    ? new CloudTrailClient({ credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken } })
    : cloudTrailClient;

  const now = new Date();
  const startTime = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const allEvents = [];
  let nextToken = undefined;

  do {
    const params = {
      LookupAttributes: [
        { AttributeKey: 'ResourceName', AttributeValue: resourceArn },
      ],
      StartTime: startTime,
      EndTime: now,
      MaxResults: MAX_RESULTS_PER_PAGE,
    };
    if (nextToken) params.NextToken = nextToken;

    const response = await lookupEventsWithRetry(params, clientToUse);
    const events = response.Events || [];
    allEvents.push(...events);
    nextToken = response.NextToken;
  } while (nextToken);

  // Aggregate events by principal
  return aggregateByPrincipal(allEvents);
};

/**
 * Aggregate CloudTrail events by principal ARN.
 * @param {Array} events - Raw CloudTrail events
 * @returns {AccessHistoryEntry[]}
 */
const aggregateByPrincipal = (events) => {
  const principalMap = new Map();

  for (const event of events) {
    // Extract principal ARN from CloudTrailEvent JSON or event fields
    let principalArn = null;
    let cloudTrailEvent = null;

    if (event.CloudTrailEvent) {
      try {
        cloudTrailEvent = JSON.parse(event.CloudTrailEvent);
        principalArn = cloudTrailEvent.userIdentity?.arn || null;
      } catch {
        // If parsing fails, skip this event
        continue;
      }
    }

    if (!principalArn) continue;

    const eventTime = event.EventTime ? new Date(event.EventTime).toISOString() : null;
    const eventName = event.EventName || (cloudTrailEvent && cloudTrailEvent.eventName) || 'Unknown';

    if (!principalMap.has(principalArn)) {
      principalMap.set(principalArn, {
        principalArn,
        principalName: extractPrincipalName(principalArn),
        lastAccessed: eventTime,
        firstAccessed: eventTime,
        accessCount: 0,
        eventNames: new Set(),
      });
    }

    const entry = principalMap.get(principalArn);
    entry.accessCount++;

    if (eventTime) {
      if (!entry.lastAccessed || eventTime > entry.lastAccessed) {
        entry.lastAccessed = eventTime;
      }
      if (!entry.firstAccessed || eventTime < entry.firstAccessed) {
        entry.firstAccessed = eventTime;
      }
    }

    if (eventName) {
      entry.eventNames.add(eventName);
    }
  }

  // Convert Sets to arrays for serialization
  const results = [];
  for (const entry of principalMap.values()) {
    results.push({
      principalArn: entry.principalArn,
      principalName: entry.principalName,
      lastAccessed: entry.lastAccessed,
      firstAccessed: entry.firstAccessed,
      accessCount: entry.accessCount,
      eventNames: Array.from(entry.eventNames),
    });
  }

  return results;
};
