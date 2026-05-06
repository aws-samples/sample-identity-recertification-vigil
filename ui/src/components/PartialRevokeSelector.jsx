/**
 * PartialRevokeSelector - Checkbox interface for selecting specific permissions to revoke.
 * Renders S3 or IAM selectors based on service type.
 * @module components/PartialRevokeSelector
 */

import { useState, useEffect } from 'react';

/**
 * Mask an access key ID to show only last 4 characters.
 * @param {string} keyId
 * @returns {string}
 */
const maskAccessKeyId = (keyId) => {
  if (!keyId || keyId.length < 4) return keyId || '-';
  return '****' + keyId.slice(-4);
};

// S3 Partial Revoke Selector 

const S3Selector = ({ accessInfo, onChange }) => {
  const [selectedStatements, setSelectedStatements] = useState([]);
  const [selectedGrants, setSelectedGrants] = useState([]);
  const [enablePab, setEnablePab] = useState(false);

  const { bucketPolicy, acl } = accessInfo;
  const statements = bucketPolicy?.Statement || [];
  const ownerID = acl?.Owner?.ID;
  const nonOwnerGrants = (acl?.Grants || []).filter(
    (g) => g.Grantee?.ID !== ownerID || !g.Grantee?.ID
  );

  useEffect(() => {
    const payload = {
      policyStatements: selectedStatements,
      aclGrants: selectedGrants,
      enablePublicAccessBlock: enablePab,
    };
    onChange(payload);
  }, [selectedStatements, selectedGrants, enablePab]);

  const toggleStatement = (sid) => {
    setSelectedStatements((prev) =>
      prev.includes(sid) ? prev.filter((s) => s !== sid) : [...prev, sid]
    );
  };

  const toggleGrant = (granteeId) => {
    setSelectedGrants((prev) =>
      prev.includes(granteeId) ? prev.filter((g) => g !== granteeId) : [...prev, granteeId]
    );
  };

  return (
    <div className="partial-revoke-selector">
      {/* Policy Statements */}
      {statements.length > 0 && (
        <div className="partial-revoke-section">
          <h5 className="partial-revoke-section-title">Bucket Policy Statements</h5>
          {statements.map((stmt, idx) => {
            const sid = stmt.Sid || `Statement-${idx}`;
            return (
              <label key={sid} className="partial-revoke-checkbox">
                <input
                  type="checkbox"
                  checked={selectedStatements.includes(sid)}
                  onChange={() => toggleStatement(sid)}
                />
                <span>{sid} - {stmt.Effect} {formatActionsShort(stmt.Action)}</span>
              </label>
            );
          })}
        </div>
      )}

      {/* ACL Grants (excluding owner) */}
      {nonOwnerGrants.length > 0 && (
        <div className="partial-revoke-section">
          <h5 className="partial-revoke-section-title">ACL Grants</h5>
          {nonOwnerGrants.map((grant, idx) => {
            const granteeId = grant.Grantee?.URI || grant.Grantee?.ID || `grant-${idx}`;
            return (
              <label key={granteeId} className="partial-revoke-checkbox">
                <input
                  type="checkbox"
                  checked={selectedGrants.includes(granteeId)}
                  onChange={() => toggleGrant(granteeId)}
                />
                <span>{grant.Grantee?.URI || grant.Grantee?.DisplayName || granteeId} - {grant.Permission}</span>
              </label>
            );
          })}
        </div>
      )}

      {/* Public Access Block Toggle */}
      <div className="partial-revoke-section">
        <h5 className="partial-revoke-section-title">Public Access Block</h5>
        <label className="partial-revoke-checkbox">
          <input
            type="checkbox"
            checked={enablePab}
            onChange={() => setEnablePab((prev) => !prev)}
          />
          <span>Enable all public access block settings</span>
        </label>
      </div>
    </div>
  );
};

// IAM Partial Revoke Selector 

const IamSelector = ({ accessInfo, onChange }) => {
  const [selectedPolicies, setSelectedPolicies] = useState([]);
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [selectedKeys, setSelectedKeys] = useState([]);

  const { attachedPolicies = [], groups = [], accessKeys = [] } = accessInfo;
  const activeKeys = accessKeys.filter((k) => k.Status === 'Active');

  useEffect(() => {
    const payload = {
      managedPolicies: selectedPolicies,
      groups: selectedGroups,
      accessKeys: selectedKeys,
    };
    onChange(payload);
  }, [selectedPolicies, selectedGroups, selectedKeys]);

  const togglePolicy = (arn) => {
    setSelectedPolicies((prev) =>
      prev.includes(arn) ? prev.filter((p) => p !== arn) : [...prev, arn]
    );
  };

  const toggleGroup = (name) => {
    setSelectedGroups((prev) =>
      prev.includes(name) ? prev.filter((g) => g !== name) : [...prev, name]
    );
  };

  const toggleKey = (keyId) => {
    setSelectedKeys((prev) =>
      prev.includes(keyId) ? prev.filter((k) => k !== keyId) : [...prev, keyId]
    );
  };

  return (
    <div className="partial-revoke-selector">
      {/* Managed Policies */}
      {attachedPolicies.length > 0 && (
        <div className="partial-revoke-section">
          <h5 className="partial-revoke-section-title">Managed Policies</h5>
          {attachedPolicies.map((p) => (
            <label key={p.PolicyArn} className="partial-revoke-checkbox">
              <input
                type="checkbox"
                checked={selectedPolicies.includes(p.PolicyArn)}
                onChange={() => togglePolicy(p.PolicyArn)}
              />
              <span>{p.PolicyName}</span>
            </label>
          ))}
        </div>
      )}

      {/* Group Memberships */}
      {groups.length > 0 && (
        <div className="partial-revoke-section">
          <h5 className="partial-revoke-section-title">Group Memberships</h5>
          {groups.map((g) => (
            <label key={g.GroupName} className="partial-revoke-checkbox">
              <input
                type="checkbox"
                checked={selectedGroups.includes(g.GroupName)}
                onChange={() => toggleGroup(g.GroupName)}
              />
              <span>{g.GroupName}</span>
            </label>
          ))}
        </div>
      )}

      {/* Active Access Keys */}
      {activeKeys.length > 0 && (
        <div className="partial-revoke-section">
          <h5 className="partial-revoke-section-title">Access Keys</h5>
          {activeKeys.map((key) => (
            <label key={key.AccessKeyId} className="partial-revoke-checkbox">
              <input
                type="checkbox"
                checked={selectedKeys.includes(key.AccessKeyId)}
                onChange={() => toggleKey(key.AccessKeyId)}
              />
              <span>{maskAccessKeyId(key.AccessKeyId)} - {key.Status}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

// Helpers 

const formatActionsShort = (actions) => {
  if (!actions) return '';
  if (typeof actions === 'string') return actions;
  if (Array.isArray(actions)) return actions.length > 2 ? `${actions[0]} +${actions.length - 1} more` : actions.join(', ');
  return '';
};

// Main Component 

const PartialRevokeSelector = ({ accessInfo, service, onSelectionChange }) => {
  if (!accessInfo) return null;

  const isS3 = service === 's3';
  const isIam = service === 'iam' || service === 'iam:user';

  const handleChange = (payload) => {
    if (onSelectionChange) onSelectionChange(payload);
  };

  return (
    <div className="partial-revoke-container">
      {isS3 && <S3Selector accessInfo={accessInfo} onChange={handleChange} />}
      {isIam && <IamSelector accessInfo={accessInfo} onChange={handleChange} />}
    </div>
  );
};

export default PartialRevokeSelector;
