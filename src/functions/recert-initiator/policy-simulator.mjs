/**
 * Policy Simulator Client - evaluates effective IAM permissions for principals against S3 resources.
 * Uses SimulatePrincipalPolicy to determine which IAM users can access a given resource.
 * Implements rate limiting (token bucket), exponential backoff retry, and concurrency control.
 * @module functions/recert-initiator/policy-simulator
 */

import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';

const iamClient = new IAMClient({});

const S3_ACTIONS = ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:DeleteObject'];
const MAX_REQUESTS_PER_SECOND = 8;
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 200;
const MAX_CONCURRENCY = 3;

/** Resource-type-specific IAM actions to simulate */
const ACTIONS_BY_RESOURCE_TYPE = {
  's3:bucket': ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:DeleteObject'],
  'ec2:instance': ['ec2:StartInstances', 'ec2:StopInstances', 'ec2:TerminateInstances', 'ec2:DescribeInstances', 'ec2:RebootInstances', 'ssm:StartSession'],
  'lambda:function': ['lambda:InvokeFunction', 'lambda:GetFunction', 'lambda:UpdateFunctionCode', 'lambda:DeleteFunction'],
  'rds:db': ['rds:DescribeDBInstances', 'rds:StopDBInstance', 'rds:StartDBInstance', 'rds:DeleteDBInstance', 'rds:ModifyDBInstance'],
  'dynamodb:table': ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:UpdateItem'],
  'sns:topic': ['sns:Publish', 'sns:Subscribe', 'sns:DeleteTopic'],
  'sqs:queue': ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:DeleteQueue'],
  'iam:user': ['iam:GetUser', 'iam:UpdateUser', 'iam:DeleteUser', 'iam:CreateAccessKey'],
  'iam:role': ['iam:GetRole', 'iam:UpdateRole', 'iam:DeleteRole', 'iam:PassRole', 'sts:AssumeRole'],
};

/** Get actions to simulate for a given resource type */
const getActionsForResourceType = (resourceType) => {
  return ACTIONS_BY_RESOURCE_TYPE[resourceType] || ACTIONS_BY_RESOURCE_TYPE['s3:bucket'];
};

// Token Bucket Rate Limiter 

const requestTimestamps = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForRateLimit = async () => {
  const now = Date.now();
  // Remove timestamps older than 1 second
  while (requestTimestamps.length > 0 && requestTimestamps[0] <= now - 1000) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= MAX_REQUESTS_PER_SECOND) {
    const oldestInWindow = requestTimestamps[0];
    const delay = 1000 - (now - oldestInWindow);
    if (delay > 0) {
      await sleep(delay);
    }
    // Recurse to re-check after waiting
    return waitForRateLimit();
  }
  requestTimestamps.push(Date.now());
};

// Retry with Exponential Backoff 

const isThrottleError = (error) => {
  const name = error.name || error.Code || '';
  return name === 'Throttling' || name === 'ThrottlingException' || name === 'TooManyRequestsException';
};

const isNoSuchEntityError = (error) => {
  const name = error.name || error.Code || '';
  return name === 'NoSuchEntity' || name === 'NoSuchEntityException';
};

const simulateWithRetry = async (params, client, retryCount = 0) => {
  try {
    await waitForRateLimit();
    const result = await client.send(new SimulatePrincipalPolicyCommand(params));
    return result;
  } catch (error) {
    if (isNoSuchEntityError(error)) {
      console.error(JSON.stringify({
        errorCode: 'PRINCIPAL_NOT_FOUND',
        message: error.message,
        principalArn: params.PolicySourceArn,
        function: 'policy-simulator',
        timestamp: new Date().toISOString(),
      }));
      return null; // Skip this principal
    }
    if (isThrottleError(error) && retryCount < MAX_RETRIES) {
      const delay = BASE_BACKOFF_MS * Math.pow(2, retryCount);
      if (retryCount >= 2) {
        console.error(JSON.stringify({
          errorCode: 'SIMULATOR_THROTTLE_RETRY',
          message: `Retry ${retryCount + 1}/${MAX_RETRIES} after ${delay}ms`,
          principalArn: params.PolicySourceArn,
          function: 'policy-simulator',
          timestamp: new Date().toISOString(),
        }));
      }
      await sleep(delay);
      return simulateWithRetry(params, client, retryCount + 1);
    }
    throw error;
  }
};

// Concurrency Control (Promise Pool / Semaphore) 

const processWithConcurrency = async (items, concurrency, fn) => {
  const results = [];
  let index = 0;

  const worker = async () => {
    while (index < items.length) {
      const currentIndex = index++;
      const result = await fn(items[currentIndex]);
      results[currentIndex] = result;
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
};

// Main Export 

/**
 * Simulate access for all IAM users against a resource.
 * @param {string} resourceArn - Resource ARN (S3 bucket, EC2 instance, Lambda, etc.)
 * @param {Array<{arn: string, userName: string}>} principals - IAM users to evaluate
 * @param {object} [credentials] - Optional cross-account credentials
 * @param {string} [resourceType] - Resource type (e.g., 's3:bucket', 'ec2:instance')
 * @returns {Promise<SimulationResult[]>}
 */
export const simulateAccessForResource = async (resourceArn, principals, credentials, resourceType) => {
  if (!principals || principals.length === 0) return [];

  const clientToUse = credentials
    ? new IAMClient({ credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken } })
    : iamClient;

  const actions = getActionsForResourceType(resourceType);
  // For S3, simulate against both bucket and bucket/* ARNs
  const resourceArns = resourceType === 's3:bucket'
    ? [resourceArn, `${resourceArn}/*`]
    : [resourceArn];

  const simulatePrincipal = async (principal) => {
    const params = {
      PolicySourceArn: principal.arn,
      ActionNames: actions,
      ResourceArns: resourceArns,
    };

    const response = await simulateWithRetry(params, clientToUse);
    if (!response) return null; // Principal was skipped (NoSuchEntity)

    const evaluationResults = response.EvaluationResults || [];
    const allowedActions = [];
    const deniedActions = [];

    for (const evalResult of evaluationResults) {
      if (evalResult.EvalDecision === 'allowed') {
        allowedActions.push(evalResult.EvalActionName);
      } else {
        deniedActions.push(evalResult.EvalActionName);
      }
    }

    // Deduplicate actions (evaluated against both resourceArn and resourceArn/*)
    const uniqueAllowed = [...new Set(allowedActions)];
    const uniqueDenied = [...new Set(deniedActions)];

    // Only include principal if at least one action is allowed
    if (uniqueAllowed.length === 0) return null;

    return {
      principalArn: principal.arn,
      principalName: principal.userName,
      principalType: 'IAM_USER',
      allowedActions: uniqueAllowed,
      deniedActions: uniqueDenied,
      accessSource: 'IAM_POLICY',
    };
  };

  const results = await processWithConcurrency(principals, MAX_CONCURRENCY, simulatePrincipal);
  return results.filter((r) => r !== null);
};
