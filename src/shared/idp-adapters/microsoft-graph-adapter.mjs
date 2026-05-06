/**
 * Microsoft Graph adapter - checks user existence via Graph API.
 * Uses OAuth2 client credentials flow for authentication.
 * @module shared/idp-adapters/microsoft-graph-adapter
 */

import { BaseIdpAdapter, logAdapterError, logAdapterInfo } from './base-idp-adapter.mjs';

/**
 * Microsoft Graph IdP adapter.
 * Credentials format: JSON string { clientId, clientSecret, tenantId }
 */
class MicrosoftGraphAdapter extends BaseIdpAdapter {
  constructor(config) {
    super(config);
    this.adapterName = 'microsoft_graph';
    this._accessToken = null;
    this._tokenExpiresAt = 0;
    const creds = typeof config.credentials === 'string'
      ? JSON.parse(config.credentials)
      : config.credentials;
    this.clientId = creds.clientId;
    this.clientSecret = creds.clientSecret;
    this.tenantId = creds.tenantId;
  }

  /**
   * Obtain or refresh OAuth2 access token.
   * @returns {Promise<string>}
   */
  async _getAccessToken() {
    if (this._accessToken && Date.now() < this._tokenExpiresAt - 60_000) {
      return this._accessToken;
    }
    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });

    const response = await this._fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token request failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    this._accessToken = data.access_token;
    this._tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    logAdapterInfo(this.adapterName, 'TOKEN_REFRESHED', { expiresIn: data.expires_in });
    return this._accessToken;
  }

  /** @override */
  async _checkUserExists(email) {
    const token = await this._getAccessToken();
    const url = `${this.endpoint}/users/${encodeURIComponent(email)}`;
    const response = await this._fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 404) {
      return { exists: false };
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Graph API error: ${response.status} ${text}`);
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
    const token = await this._getAccessToken();
    const url = `${this.endpoint}/organization`;
    const response = await this._fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { statusCode: response.status };
  }
}

export { MicrosoftGraphAdapter };
