/**
 * Access Discovery Engine - orchestrates Policy Simulator + CloudTrail Analyzer
 * and merges results into a unified accessEntries array per resource.
 * Handles timeout guards and bucket policy principal extraction.
 * @module functions/recert-initiator/access-discovery
 */

import { simulateAccessForResource } from './policy-simulator.mjs';
import { getAccessHistory } from './cloudtrail-analyzer.mjs';
import { ResourceGroupsTaggingAPIClient, GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';

const TIMEOUT_THRESHOLD_MS = 280000;
const taggingClient = new ResourceGroupsTaggingAPIClient({});

// Helpers 

/**
 * Extract principal name from ARN (last segment after / or :).
 * @param {string} arn
 * @returns {string}
 */
const extractPrincipalName = (arn) => {
  if (!arn) return 'unknown';
  const slashIndex = arn.lastIndexOf('/');
  if (slashIndex !== -1) return arn.substring(slashIndex + 1);
  const colonIndex = arn.lastIndexOf(':');
  if (colonIndex !== -1) return arn.substring(colonIndex + 1);
  return arn;
};

/**
 * Determine principal type from ARN pattern.
 * @param {string} arn
 * @returns {string}
 */
const determinePrincipalType = (arn) => {
  if (!arn) return 'IAM_USER';
  if (arn.includes(':user/')) return 'IAM_USER';
  if (arn.includes(':role/')) return 'IAM_ROLE';
  if (arn.includes(':assumed-role/')) return 'IAM_ROLE';
  if (arn.includes('.amazonaws.com')) return 'AWS_SERVICE';
  if (/^arn:aws:iam::\d{12}:root$/.test(arn)) return 'AWS_ACCOUNT';
  if (/^\d{12}$/.test(arn)) return 'AWS_ACCOUNT';
  return 'IAM_USER';
};

/**
 * Extract principals from a bucket policy document.
 * For AWS_SERVICE principals, also extracts sourceArn from Condition blocks
 * and derives a friendly principalName.
 * @param {object|null} bucketPolicy - Parsed bucket policy JSON
 * @returns {Array<{principalArn: string, principalName: string, principalType: string, sourceArn?: string}>}
 */
const extractBucketPolicyPrincipals = (bucketPolicy) => {
  if (!bucketPolicy || !bucketPolicy.Statement) return [];

  const principals = new Map();

  for (const statement of bucketPolicy.Statement) {
    if (statement.Effect !== 'Allow') continue;

    const principal = statement.Principal;
    if (!principal) continue;

    let arns = [];
    let isServicePrincipal = false;
    if (typeof principal === 'string') {
      arns = [principal];
    } else if (principal.AWS) {
      arns = Array.isArray(principal.AWS) ? principal.AWS : [principal.AWS];
    } else if (principal.Service) {
      const services = Array.isArray(principal.Service) ? principal.Service : [principal.Service];
      arns = services;
      isServicePrincipal = true;
    }

    // Extract sourceArn from Condition if present (for service principals)
    const sourceArn = extractSourceArnFromCondition(statement.Condition);

    for (const arn of arns) {
      if (arn === '*') continue; // Skip wildcard principals
      if (!principals.has(arn)) {
        const principalType = determinePrincipalType(arn);
        let principalName = extractPrincipalName(arn);

        // Enrich service principal name with resource info from sourceArn
        if (principalType === 'AWS_SERVICE' && sourceArn) {
          const resourceName = extractResourceNameFromArn(sourceArn);
          const serviceName = arn.replace('.amazonaws.com', '');
          principalName = `${serviceName.charAt(0).toUpperCase() + serviceName.slice(1)}: ${resourceName}`;
        }

        const entry = {
          principalArn: arn,
          principalName,
          principalType,
        };

        if (principalType === 'AWS_SERVICE' && sourceArn) {
          entry.sourceArn = sourceArn;
        }

        principals.set(arn, entry);
      }
    }
  }

  return Array.from(principals.values());
};

/**
 * Extract aws:SourceArn from a policy statement's Condition block.
 * Checks ArnLike, ArnEquals, StringEquals, StringLike on aws:SourceArn.
 * @param {object|null} condition
 * @returns {string|null}
 */
const extractSourceArnFromCondition = (condition) => {
  if (!condition) return null;

  const conditionKeys = ['ArnLike', 'ArnEquals', 'StringEquals', 'StringLike'];
  for (const key of conditionKeys) {
    const block = condition[key];
    if (!block) continue;
    const sourceArn = block['aws:SourceArn'] || block['AWS:SourceArn'];
    if (sourceArn) {
      return Array.isArray(sourceArn) ? sourceArn[0] : sourceArn;
    }
  }
  return null;
};

/**
 * Extract a human-readable resource name from an ARN.
 * @param {string} arn
 * @returns {string}
 */
const extractResourceNameFromArn = (arn) => {
  if (!arn) return 'unknown';
  const parts = arn.split(':');
  const resourcePart = parts.slice(5).join(':');
  if (resourcePart.includes('/')) {
    return resourcePart.split('/').pop();
  }
  if (resourcePart.includes(':')) {
    return resourcePart.split(':').pop();
  }
  return resourcePart || 'unknown';
};

// Merge Logic 

/**
 * Merge Policy Simulator results with CloudTrail access history.
 * @param {Array} simulatorResults - Results from simulateAccessForResource
 * @param {Array} cloudTrailResults - Results from getAccessHistory
 * @param {Array} bucketPolicyPrincipals - Principals extracted from bucket policy
 * @returns {Array<AccessEntry>}
 */
const mergeResults = (simulatorResults, cloudTrailResults, bucketPolicyPrincipals) => {
  const accessMap = new Map();

  // Add simulator results (who CAN access)
  for (const simResult of simulatorResults) {
    accessMap.set(simResult.principalArn, {
      principalArn: simResult.principalArn,
      principalName: simResult.principalName,
      principalType: simResult.principalType,
      accessSource: simResult.accessSource,
      permissions: simResult.allowedActions || [],
      lastAccessed: null,
      accessCount: 0,
      firstAccessed: null,
    });
  }

  // Merge CloudTrail results (who HAS accessed)
  for (const ctResult of cloudTrailResults) {
    if (accessMap.has(ctResult.principalArn)) {
      // Principal in both sources - add history to existing entry
      const entry = accessMap.get(ctResult.principalArn);
      entry.lastAccessed = ctResult.lastAccessed;
      entry.firstAccessed = ctResult.firstAccessed;
      entry.accessCount = ctResult.accessCount;
    } else {
      // Principal only in CloudTrail - access was revoked but history exists
      accessMap.set(ctResult.principalArn, {
        principalArn: ctResult.principalArn,
        principalName: ctResult.principalName,
        principalType: determinePrincipalType(ctResult.principalArn),
        accessSource: 'HISTORICAL',
        permissions: [],
        lastAccessed: ctResult.lastAccessed,
        firstAccessed: ctResult.firstAccessed,
        accessCount: ctResult.accessCount,
      });
    }
  }

  // Add bucket policy principals (if not already in map)
  for (const bpPrincipal of bucketPolicyPrincipals) {
    if (!accessMap.has(bpPrincipal.principalArn)) {
      accessMap.set(bpPrincipal.principalArn, {
        principalArn: bpPrincipal.principalArn,
        principalName: bpPrincipal.principalName,
        principalType: bpPrincipal.principalType,
        accessSource: 'BUCKET_POLICY',
        permissions: [],
        lastAccessed: null,
        accessCount: 0,
        firstAccessed: null,
        sourceArn: bpPrincipal.sourceArn || null,
        sourceOwner: null,
      });
    }
  }

  return Array.from(accessMap.values());
};

// Service Principal Owner Enrichment 

/**
 * For AWS_SERVICE principals with a sourceArn, look up the owner tag via Tagging API.
 * @param {Array} accessEntries - Merged access entries
 * @returns {Promise<void>}
 */
const enrichServicePrincipalsWithOwner = async (accessEntries) => {
  const serviceEntries = accessEntries.filter(
    (e) => e.principalType === 'AWS_SERVICE' && e.sourceArn
  );
  if (serviceEntries.length === 0) return;

  for (const entry of serviceEntries) {
    try {
      const ownerEmail = await lookupResourceOwner(entry.sourceArn);
      if (ownerEmail) {
        entry.sourceOwner = ownerEmail;
      }
    } catch (err) {
      // Non-critical - log and continue
      console.error(JSON.stringify({
        errorCode: 'SOURCE_OWNER_LOOKUP_FAILED',
        message: err.message,
        sourceArn: entry.sourceArn,
        function: 'access-discovery',
        timestamp: new Date().toISOString(),
      }));
    }
  }
};

/**
 * Look up the owner tag of a resource via the Resource Groups Tagging API.
 * @param {string} resourceArn
 * @returns {Promise<string|null>} Owner email or null
 */
const lookupResourceOwner = async (resourceArn) => {
  try {
    const result = await taggingClient.send(new GetResourcesCommand({
      ResourceARNList: [resourceArn],
    }));
    const mapping = (result.ResourceTagMappingList || [])[0];
    if (!mapping) return null;
    const ownerTag = (mapping.Tags || []).find((t) => t.Key === 'owner');
    return ownerTag?.Value || null;
  } catch {
    return null;
  }
};

// Main Export 

/**
 * Discover all principals with access to a resource.
 * @param {string} resourceArn - Resource ARN (S3 bucket, EC2 instance, Lambda, etc.)
 * @param {Array<{arn: string, userName: string}>} iamUsers - IAM users to evaluate
 * @param {object} [options] - Optional configuration
 * @param {number} [options.startTime] - Start timestamp for timeout guard
 * @param {object} [options.accessInfo] - Resource access info containing bucketPolicy
 * @param {object} [options.credentials] - Cross-account credentials
 * @param {string} [options.resourceType] - Resource type (e.g., 's3:bucket', 'ec2:instance')
 * @returns {Promise<AccessEntry[]>}
 */
export const discoverAccess = async (resourceArn, iamUsers, options = {}) => {
  const { startTime, accessInfo, credentials, resourceType } = options;

  // Timeout guard
  if (startTime && Date.now() - startTime > TIMEOUT_THRESHOLD_MS) {
    console.error(JSON.stringify({
      errorCode: 'PARTIAL_DISCOVERY_WARNING',
      message: 'Approaching Lambda timeout, returning partial results',
      resourceArn,
      function: 'access-discovery',
      timestamp: new Date().toISOString(),
    }));
    return [];
  }

  const executionStart = Date.now();

  // Call both sources in parallel
  const [simulatorResults, cloudTrailResults] = await Promise.all([
    simulateAccessForResource(resourceArn, iamUsers, credentials, resourceType),
    getAccessHistory(resourceArn, credentials),
  ]);

  // Extract bucket policy principals if available (S3 only)
  const bucketPolicyPrincipals = (resourceType === 's3:bucket' && accessInfo?.bucketPolicy)
    ? extractBucketPolicyPrincipals(accessInfo.bucketPolicy)
    : [];

  // Merge results
  const accessEntries = mergeResults(simulatorResults, cloudTrailResults, bucketPolicyPrincipals);

  // Enrich AWS_SERVICE principals with sourceOwner from Tagging API
  await enrichServicePrincipalsWithOwner(accessEntries);

  // Log progress metrics
  const executionTime = Date.now() - executionStart;
  console.log(JSON.stringify({
    event: 'ACCESS_DISCOVERY_COMPLETE',
    resourceArn,
    principalsEvaluated: iamUsers.length,
    principalsWithAccess: simulatorResults.length,
    cloudTrailPrincipals: cloudTrailResults.length,
    bucketPolicyPrincipals: bucketPolicyPrincipals.length,
    totalAccessEntries: accessEntries.length,
    executionTimeMs: executionTime,
    function: 'access-discovery',
    timestamp: new Date().toISOString(),
  }));

  return accessEntries;
};
