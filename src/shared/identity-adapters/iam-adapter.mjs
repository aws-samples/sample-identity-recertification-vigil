/**
 * IAM identity source adapter - enumerates, inspects, and disables
 * IAM users in the current AWS account.
 * @module shared/identity-adapters/iam-adapter
 */

import {
  IAMClient,
  ListUsersCommand,
  GetUserCommand,
  ListGroupsForUserCommand,
  ListAttachedUserPoliciesCommand,
  ListUserPoliciesCommand,
  ListAccessKeysCommand,
  GetAccessKeyLastUsedCommand,
  UpdateAccessKeyCommand,
  DeleteLoginProfileCommand,
  RemoveUserFromGroupCommand,
  ListUserTagsCommand,
} from '@aws-sdk/client-iam';
import { BaseIdentityAdapter, withRetry } from './base-adapter.mjs';
import { toISOString } from '../time-utils.mjs';

const iamClient = new IAMClient({});

/**
 * Extract email from IAM user tags.
 * @param {Array<{Key: string, Value: string}>} tags
 * @returns {string}
 */
const getEmailFromTags = (tags) => {
  const emailTag = (tags || []).find((t) => t.Key === 'email' || t.Key === 'Email');
  return emailTag?.Value || '';
};

/**
 * Normalize an IAM user to the standard adapter shape.
 * @param {object} user - IAM user object
 * @param {object} [extra] - Additional fields (groups, policies, accessKeys, tags)
 * @returns {import('./base-adapter.mjs').NormalizedUser & { arn: string, createDate: string, passwordLastUsed?: string, attachedPolicies: string[], inlinePolicies: string[], accessKeys: object[], tags: object }}
 */
const normalizeIamUser = (user, extra = {}) => ({
  userId: user.UserName,
  userName: user.UserName,
  email: getEmailFromTags(extra.tags) || '',
  identitySource: 'IAM',
  arn: user.Arn,
  createDate: user.CreateDate ? toISOString(user.CreateDate) : undefined,
  passwordLastUsed: user.PasswordLastUsed ? toISOString(user.PasswordLastUsed) : undefined,
  groups: (extra.groups || []).map((g) => g.GroupName || g),
  attachedPolicies: extra.attachedPolicies || [],
  inlinePolicies: extra.inlinePolicies || [],
  accessKeys: extra.accessKeys || [],
  tags: extra.tags || [],
  status: 'ACTIVE',
});

/**
 * IAM adapter for identity source operations.
 */
class IamAdapter extends BaseIdentityAdapter {
  constructor() {
    super();
    this.adapterName = 'iam';
  }

  async listUsers() {
    const users = [];
    let marker;

    do {
      const result = await withRetry(
        () => iamClient.send(new ListUsersCommand({ Marker: marker, MaxItems: 100 })),
        { adapterName: this.adapterName },
      );
      for (const user of result.Users || []) {
        users.push(normalizeIamUser(user));
      }
      marker = result.IsTruncated ? result.Marker : undefined;
    } while (marker);

    return users;
  }

  async getUser(userName) {
    const userResult = await withRetry(
      () => iamClient.send(new GetUserCommand({ UserName: userName })),
      { adapterName: this.adapterName },
    );
    const user = userResult.User;

    const [groupsResult, policiesResult, inlineResult, keysResult, tagsResult] = await Promise.all([
      withRetry(() => iamClient.send(new ListGroupsForUserCommand({ UserName: userName })), { adapterName: this.adapterName }),
      withRetry(() => iamClient.send(new ListAttachedUserPoliciesCommand({ UserName: userName })), { adapterName: this.adapterName }),
      withRetry(() => iamClient.send(new ListUserPoliciesCommand({ UserName: userName })), { adapterName: this.adapterName }),
      withRetry(() => iamClient.send(new ListAccessKeysCommand({ UserName: userName })), { adapterName: this.adapterName }),
      withRetry(() => iamClient.send(new ListUserTagsCommand({ UserName: userName })), { adapterName: this.adapterName }),
    ]);

    const accessKeys = await Promise.all(
      (keysResult.AccessKeyMetadata || []).map(async (key) => {
        const lastUsed = await withRetry(
          () => iamClient.send(new GetAccessKeyLastUsedCommand({ AccessKeyId: key.AccessKeyId })),
          { adapterName: this.adapterName },
        );
        return {
          accessKeyId: key.AccessKeyId,
          status: key.Status,
          createDate: key.CreateDate ? toISOString(key.CreateDate) : undefined,
          lastUsedDate: lastUsed.AccessKeyLastUsed?.LastUsedDate
            ? toISOString(lastUsed.AccessKeyLastUsed.LastUsedDate)
            : undefined,
        };
      }),
    );

    return normalizeIamUser(user, {
      groups: groupsResult.Groups || [],
      attachedPolicies: (policiesResult.AttachedPolicies || []).map((p) => p.PolicyArn),
      inlinePolicies: inlineResult.PolicyNames || [],
      accessKeys,
      tags: tagsResult.Tags || [],
    });
  }

  async disableUser(userName) {
    // 1. Deactivate all access keys
    const keysResult = await withRetry(
      () => iamClient.send(new ListAccessKeysCommand({ UserName: userName })),
      { adapterName: this.adapterName },
    );
    for (const key of keysResult.AccessKeyMetadata || []) {
      if (key.Status === 'Active') {
        await withRetry(
          () => iamClient.send(new UpdateAccessKeyCommand({
            UserName: userName,
            AccessKeyId: key.AccessKeyId,
            Status: 'Inactive',
          })),
          { adapterName: this.adapterName },
        );
      }
    }

    // 2. Delete login profile (console access)
    try {
      await withRetry(
        () => iamClient.send(new DeleteLoginProfileCommand({ UserName: userName })),
        { adapterName: this.adapterName },
      );
    } catch (error) {
      // NoSuchEntity means no login profile - that's fine
      if (error.name !== 'NoSuchEntityException') throw error;
    }

    // 3. Remove from all groups
    const groupsResult = await withRetry(
      () => iamClient.send(new ListGroupsForUserCommand({ UserName: userName })),
      { adapterName: this.adapterName },
    );
    for (const group of groupsResult.Groups || []) {
      await withRetry(
        () => iamClient.send(new RemoveUserFromGroupCommand({
          UserName: userName,
          GroupName: group.GroupName,
        })),
        { adapterName: this.adapterName },
      );
    }

    return {
      success: true,
      disabledAt: toISOString(new Date()),
      details: {
        keysDeactivated: (keysResult.AccessKeyMetadata || []).filter((k) => k.Status === 'Active').length,
        loginProfileDeleted: true,
        groupsRemoved: (groupsResult.Groups || []).map((g) => g.GroupName),
      },
    };
  }

  async getUserGroups(userName) {
    const result = await withRetry(
      () => iamClient.send(new ListGroupsForUserCommand({ UserName: userName })),
      { adapterName: this.adapterName },
    );
    return (result.Groups || []).map((g) => ({
      groupId: g.GroupName,
      groupName: g.GroupName,
    }));
  }
}

export { IamAdapter, normalizeIamUser, getEmailFromTags };
