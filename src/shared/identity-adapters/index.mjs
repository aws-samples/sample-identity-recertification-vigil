/**
 * Identity source adapter factory - returns the appropriate adapter
 * for Cognito, IAM, or Identity Center identity sources.
 * Caches adapter instances per source for Lambda execution lifetime.
 * @module shared/identity-adapters
 */

import { CognitoAdapter } from './cognito-adapter.mjs';
import { IamAdapter } from './iam-adapter.mjs';
import { IdentityCenterAdapter } from './identity-center-adapter.mjs';

const ADAPTERS = {
  COGNITO: CognitoAdapter,
  JIT: CognitoAdapter,
  IAM: IamAdapter,
  IDENTITY_CENTER: IdentityCenterAdapter,
};

/** Module-level cache for adapter instances */
const adapterCache = {};

/**
 * Get an identity source adapter instance.
 * @param {string} identitySource - COGNITO | JIT | IAM | IDENTITY_CENTER
 * @returns {import('./base-adapter.mjs').BaseIdentityAdapter}
 * @throws {Error} If identity source is unknown
 */
const getAdapter = (identitySource) => {
  if (adapterCache[identitySource]) return adapterCache[identitySource];

  let AdapterClass;
  switch (identitySource) {
    case 'COGNITO':
    case 'JIT':
      AdapterClass = CognitoAdapter;
      break;
    case 'IAM':
      AdapterClass = IamAdapter;
      break;
    case 'IDENTITY_CENTER':
      AdapterClass = IdentityCenterAdapter;
      break;
    default:
      throw new Error(`Unknown identity source: ${identitySource}`);
  }

  adapterCache[identitySource] = new AdapterClass();
  return adapterCache[identitySource];
};

/**
 * Clear adapter cache (useful for testing).
 */
const clearAdapterCache = () => {
  for (const key of Object.keys(adapterCache)) {
    delete adapterCache[key];
  }
};

export { getAdapter, clearAdapterCache, ADAPTERS };
