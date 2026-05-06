/**
 * Cognito identity source adapter - enumerates, inspects, and disables
 * users in the Cognito User Pool.
 * @module shared/identity-adapters/cognito-adapter
 */

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminGetUserCommand,
  AdminDisableUserCommand,
  AdminUserGlobalSignOutCommand,
  AdminListGroupsForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { BaseIdentityAdapter, withRetry } from './base-adapter.mjs';
import { toISOString } from '../time-utils.mjs';

const cognitoClient = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;

/**
 * Extract an attribute value from Cognito user attributes array.
 * @param {Array<{Name: string, Value: string}>} attrs
 * @param {string} name
 * @returns {string|undefined}
 */
const getAttr = (attrs, name) => {
  const attr = (attrs || []).find((a) => a.Name === name);
  return attr?.Value;
};

/**
 * Normalize a Cognito user object to the standard adapter shape.
 * @param {object} user - Cognito user object
 * @param {string[]} [groups] - Group names
 * @returns {import('./base-adapter.mjs').NormalizedUser}
 */
const normalizeCognitoUser = (user, groups = []) => ({
  userId: getAttr(user.Attributes || user.UserAttributes, 'sub') || user.Username,
  userName: user.Username,
  email: getAttr(user.Attributes || user.UserAttributes, 'email') || '',
  customOwner: getAttr(user.Attributes || user.UserAttributes, 'custom:owner') || '',
  identitySource: 'COGNITO',
  status: user.UserStatus || user.Enabled === false ? 'DISABLED' : 'ENABLED',
  groups,
  createdAt: user.UserCreateDate ? toISOString(user.UserCreateDate) : undefined,
});

/**
 * Cognito adapter for identity source operations.
 */
class CognitoAdapter extends BaseIdentityAdapter {
  constructor() {
    super();
    this.adapterName = 'cognito';
  }

  /** @returns {Promise<import('./base-adapter.mjs').NormalizedUser[]>} */
  async listUsers() {
    const users = [];
    let paginationToken;

    do {
      const result = await withRetry(
        () => cognitoClient.send(new ListUsersCommand({
          UserPoolId: USER_POOL_ID,
          Limit: 60,
          PaginationToken: paginationToken,
        })),
        { adapterName: this.adapterName },
      );
      for (const user of result.Users || []) {
        users.push(normalizeCognitoUser(user));
      }
      paginationToken = result.PaginationToken;
    } while (paginationToken);

    return users;
  }

  /** @param {string} userId - Cognito username or sub */
  async getUser(userId) {
    const result = await withRetry(
      () => cognitoClient.send(new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
      })),
      { adapterName: this.adapterName },
    );
    const groups = await this.getUserGroups(userId);
    const groupNames = groups.map((g) => g.groupName);
    return normalizeCognitoUser(
      { ...result, Attributes: result.UserAttributes },
      groupNames,
    );
  }

  /** @param {string} userId */
  async disableUser(userId) {
    await withRetry(
      () => cognitoClient.send(new AdminDisableUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
      })),
      { adapterName: this.adapterName },
    );
    await withRetry(
      () => cognitoClient.send(new AdminUserGlobalSignOutCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
      })),
      { adapterName: this.adapterName },
    );
    return { success: true, disabledAt: toISOString(new Date()) };
  }

  /** @param {string} userId */
  async getUserGroups(userId) {
    const result = await withRetry(
      () => cognitoClient.send(new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
      })),
      { adapterName: this.adapterName },
    );
    return (result.Groups || []).map((g) => ({
      groupId: g.GroupName,
      groupName: g.GroupName,
    }));
  }
}

export { CognitoAdapter, normalizeCognitoUser, getAttr };
