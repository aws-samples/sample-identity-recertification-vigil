/**
 * Identity Center (Identity Store) adapter - enumerates, inspects, and disables
 * users in the IAM Identity Center identity store.
 * MVP scope: enumerate + disable only. No permission set management.
 * @module shared/identity-adapters/identity-center-adapter
 */

import {
  IdentitystoreClient,
  ListUsersCommand,
  DescribeUserCommand,
  UpdateUserCommand,
  ListGroupMembershipsForMemberCommand,
  DescribeGroupCommand,
} from '@aws-sdk/client-identitystore';
import { BaseIdentityAdapter, withRetry } from './base-adapter.mjs';
import { toISOString } from '../time-utils.mjs';

const identityStoreClient = new IdentitystoreClient({});
const IDENTITY_STORE_ID = process.env.IDENTITY_STORE_ID;

/**
 * Normalize an Identity Center user to the standard adapter shape.
 * @param {object} user - Identity Store user object
 * @param {Array<{groupId: string, groupName: string}>} [groups]
 * @returns {import('./base-adapter.mjs').NormalizedUser & { displayName: string, externalIds: object[], emails: object[], active: boolean }}
 */
const normalizeIcUser = (user, groups = []) => {
  const primaryEmail = (user.Emails || []).find((e) => e.Primary)?.Value
    || (user.Emails || [])[0]?.Value
    || '';

  return {
    userId: user.UserId,
    userName: user.UserName || '',
    displayName: user.DisplayName || '',
    email: primaryEmail,
    identitySource: 'IDENTITY_CENTER',
    externalIds: (user.ExternalIds || []).map((e) => ({
      issuer: e.Issuer,
      id: e.Id,
    })),
    emails: (user.Emails || []).map((e) => ({
      value: e.Value,
      type: e.Type,
      primary: e.Primary || false,
    })),
    groups: groups.map((g) => g.groupName),
    active: user.Active !== false,
    status: user.Active === false ? 'DISABLED' : 'ACTIVE',
  };
};

/**
 * Identity Center adapter for identity source operations.
 */
class IdentityCenterAdapter extends BaseIdentityAdapter {
  constructor() {
    super();
    this.adapterName = 'identity-center';
  }

  async listUsers() {
    const users = [];
    let nextToken;

    do {
      const result = await withRetry(
        () => identityStoreClient.send(new ListUsersCommand({
          IdentityStoreId: IDENTITY_STORE_ID,
          MaxResults: 50,
          NextToken: nextToken,
        })),
        { adapterName: this.adapterName },
      );
      for (const user of result.Users || []) {
        users.push(normalizeIcUser(user));
      }
      nextToken = result.NextToken;
    } while (nextToken);

    return users;
  }

  async getUser(userId) {
    const result = await withRetry(
      () => identityStoreClient.send(new DescribeUserCommand({
        IdentityStoreId: IDENTITY_STORE_ID,
        UserId: userId,
      })),
      { adapterName: this.adapterName },
    );
    const groups = await this.getUserGroups(userId);
    return normalizeIcUser(result, groups);
  }

  async disableUser(userId) {
    await withRetry(
      () => identityStoreClient.send(new UpdateUserCommand({
        IdentityStoreId: IDENTITY_STORE_ID,
        UserId: userId,
        Operations: [
          { AttributePath: 'active', AttributeValue: { BooleanValue: false } },
        ],
      })),
      { adapterName: this.adapterName },
    );

    // ASSUMPTION: Phase 2 will handle permission set cleanup across member accounts
    console.log(JSON.stringify({
      action: 'IC_USER_DISABLED',
      warning: 'IC user disabled but permission sets in member accounts require manual cleanup - Phase 2',
      userId,
      timestamp: toISOString(new Date()),
    }));

    return {
      success: true,
      disabledAt: toISOString(new Date()),
      details: {
        warning: 'Permission set cleanup requires manual action (Phase 2)',
      },
    };
  }

  async getUserGroups(userId) {
    const memberships = [];
    let nextToken;

    do {
      const result = await withRetry(
        () => identityStoreClient.send(new ListGroupMembershipsForMemberCommand({
          IdentityStoreId: IDENTITY_STORE_ID,
          MemberId: { UserId: userId },
          MaxResults: 50,
          NextToken: nextToken,
        })),
        { adapterName: this.adapterName },
      );
      memberships.push(...(result.GroupMemberships || []));
      nextToken = result.NextToken;
    } while (nextToken);

    const groups = await Promise.all(
      memberships.map(async (m) => {
        const group = await withRetry(
          () => identityStoreClient.send(new DescribeGroupCommand({
            IdentityStoreId: IDENTITY_STORE_ID,
            GroupId: m.GroupId,
          })),
          { adapterName: this.adapterName },
        );
        return {
          groupId: m.GroupId,
          groupName: group.DisplayName || m.GroupId,
        };
      }),
    );

    return groups;
  }
}

export { IdentityCenterAdapter, normalizeIcUser };
