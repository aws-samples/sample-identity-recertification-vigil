/**
 * Cross-account credential helper - assumes VIGILCrossAccountRole in member accounts.
 * Provides consistent STS AssumeRole logic with structured error handling.
 * @module shared/cross-account-credentials
 */

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { toISOString } from './time-utils.mjs';

const stsClient = new STSClient({});

/**
 * Assume the VIGILCrossAccountRole in a target member account.
 * @param {string} accountId - 12-digit AWS account ID
 * @param {string} sessionName - Identifies the calling function (e.g., 'recert-initiator')
 * @returns {Promise<{accessKeyId: string, secretAccessKey: string, sessionToken: string}>}
 * @throws {Error} With structured log on AssumeRole failure
 */
export const assumeCrossAccountRole = async (accountId, sessionName) => {
  const roleArn = `arn:aws:iam::${accountId}:role/VIGILCrossAccountRole`;

  try {
    const result = await stsClient.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `vigil-${sessionName}`,
      DurationSeconds: 900,
    }));

    const creds = result.Credentials;
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
  } catch (error) {
    console.error(JSON.stringify({
      errorCode: 'CROSS_ACCOUNT_ASSUME_ROLE_FAILED',
      message: error.message,
      accountId,
      roleArn,
      function: 'cross-account-credentials',
      timestamp: toISOString(new Date()),
    }));
    throw error;
  }
};
