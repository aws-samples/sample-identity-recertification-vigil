/**
 * IdP adapter factory - reads SSM Parameter Store config and returns
 * the appropriate upstream IdP adapter instance.
 * Caches SSM values for Lambda execution lifetime.
 * @module shared/idp-adapters
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { MicrosoftGraphAdapter } from './microsoft-graph-adapter.mjs';
import { OktaAdapter } from './okta-adapter.mjs';
import { ScimAdapter } from './scim-adapter.mjs';
import { toISOString } from '../time-utils.mjs';

const ssmClient = new SSMClient({});

const SSM_PATHS = Object.freeze({
  TYPE: '/igs/idp/type',
  ENDPOINT: '/igs/idp/endpoint',
  CREDENTIALS: '/igs/idp/credentials',
});

const ADAPTER_MAP = Object.freeze({
  microsoft_graph: MicrosoftGraphAdapter,
  okta: OktaAdapter,
  scim_generic: ScimAdapter,
});

/** Module-level cache for SSM values (persists across invocations) */
let cachedConfig = null;

/**
 * Read a single SSM parameter.
 * @param {string} name - Parameter path
 * @param {boolean} [decrypt] - Whether to decrypt SecureString
 * @returns {Promise<string>}
 */
const getParameter = async (name, decrypt = true) => {
  const result = await ssmClient.send(new GetParameterCommand({
    Name: name,
    WithDecryption: decrypt,
  }));
  return result.Parameter?.Value || '';
};

/**
 * Load IdP configuration from SSM Parameter Store.
 * Caches result for Lambda execution lifetime.
 * @returns {Promise<{ type: string, endpoint: string, credentials: string }>}
 */
const loadIdpConfig = async () => {
  if (cachedConfig) return cachedConfig;

  const [type, endpoint, credentials] = await Promise.all([
    getParameter(SSM_PATHS.TYPE),
    getParameter(SSM_PATHS.ENDPOINT),
    getParameter(SSM_PATHS.CREDENTIALS),
  ]);

  cachedConfig = { type, endpoint, credentials };
  console.log(JSON.stringify({
    action: 'IDP_CONFIG_LOADED',
    idpType: type,
    endpoint,
    timestamp: toISOString(new Date()),
  }));
  return cachedConfig;
};

/**
 * Get an IdP adapter instance based on SSM configuration.
 * @param {string} [idpType] - Override IdP type (uses SSM if not provided)
 * @returns {Promise<import('./base-idp-adapter.mjs').BaseIdpAdapter>}
 */
const getIdpAdapter = async (idpType) => {
  const config = await loadIdpConfig();
  const type = idpType || config.type;
  const AdapterClass = ADAPTER_MAP[type];

  if (!AdapterClass) {
    throw new Error(`Unknown IdP type: ${type}. Supported: ${Object.keys(ADAPTER_MAP).join(', ')}`);
  }

  return new AdapterClass({
    endpoint: config.endpoint,
    credentials: config.credentials,
  });
};

/**
 * Clear cached SSM config (useful for testing or forced refresh).
 */
const clearIdpConfigCache = () => {
  cachedConfig = null;
};

export {
  getIdpAdapter,
  loadIdpConfig,
  clearIdpConfigCache,
  SSM_PATHS,
  ADAPTER_MAP,
  getParameter,
};
