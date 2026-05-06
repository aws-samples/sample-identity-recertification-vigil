/**
 * Okta Users adapter - checks user existence via Okta Users API.
 * Uses SSWS API token authentication.
 * @module shared/idp-adapters/okta-adapter
 */

import { BaseIdpAdapter, logAdapterError } from './base-idp-adapter.mjs';

/**
 * Okta IdP adapter.
 * Credentials format: plain API token string.
 */
class OktaAdapter extends BaseIdpAdapter {
  constructor(config) {
    super(config);
    this.adapterName = 'okta';
    this.apiToken = typeof config.credentials === 'string'
      ? config.credentials.trim()
      : config.credentials;
  }

  /** @override */
  async _checkUserExists(email) {
    const url = `${this.endpoint}/api/v1/users/${encodeURIComponent(email)}`;
    const response = await this._fetch(url, {
      headers: { Authorization: `SSWS ${this.apiToken}` },
    });

    if (response.status === 404) {
      return { exists: false };
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Okta API error: ${response.status} ${text}`);
    }

    const userData = await response.json();
    return { exists: true, userData };
  }

  /** @override */
  async _getUser(email) {
    const result = await this._checkUserExists(email);
    return result.exists ? result.userData : null;
  }

  /** @override */
  async _healthCheck() {
    const url = `${this.endpoint}/api/v1/org`;
    const response = await this._fetch(url, {
      headers: { Authorization: `SSWS ${this.apiToken}` },
    });
    return { statusCode: response.status };
  }
}

export { OktaAdapter };
