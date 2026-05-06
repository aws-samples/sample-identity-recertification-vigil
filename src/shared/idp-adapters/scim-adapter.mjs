/**
 * Generic SCIM adapter - checks user existence via SCIM 2.0 Users endpoint.
 * Uses bearer token authentication.
 * @module shared/idp-adapters/scim-adapter
 */

import { BaseIdpAdapter } from './base-idp-adapter.mjs';

/**
 * Generic SCIM IdP adapter.
 * Credentials format: plain bearer token string.
 */
class ScimAdapter extends BaseIdpAdapter {
  constructor(config) {
    super(config);
    this.adapterName = 'scim_generic';
    this.bearerToken = typeof config.credentials === 'string'
      ? config.credentials.trim()
      : config.credentials;
  }

  /** @override */
  async _checkUserExists(email) {
    const filter = `userName eq "${email}"`;
    const url = `${this.endpoint}/Users?filter=${encodeURIComponent(filter)}`;
    const response = await this._fetch(url, {
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        Accept: 'application/scim+json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`SCIM API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const resources = data.Resources || [];
    if (resources.length === 0) {
      return { exists: false };
    }
    return { exists: true, userData: resources[0] };
  }

  /** @override */
  async _getUser(email) {
    const result = await this._checkUserExists(email);
    return result.exists ? result.userData : null;
  }

  /** @override */
  async _healthCheck() {
    const url = `${this.endpoint}/ServiceProviderConfig`;
    const response = await this._fetch(url, {
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        Accept: 'application/scim+json',
      },
    });
    return { statusCode: response.status };
  }
}

export { ScimAdapter };
