/**
 * AccessDetailPanel - Interactive panel showing resource access details with
 * per-item Certify/Revoke/Modify actions. Parses policies into individual
 * actions so owners can make granular decisions.
 * @module components/AccessDetailPanel
 */

import { useState } from 'react';

/**
 * Mask an access key ID to show only last 4 characters.
 */
const maskAccessKeyId = (keyId) => {
  if (!keyId || keyId.length < 4) return keyId || '-';
  return '****' + keyId.slice(-4);
};

const fmtDate = (iso) => {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }); } catch { return iso; }
};

// Per-Item Action Buttons 

const ItemActions = ({ itemId, decisions, onDecision, disabled }) => {
  const current = decisions[itemId];
  return (
    <div className="item-actions">
      <button
        className={`item-action-btn item-action-certify ${current === 'CERTIFY' ? 'active' : ''}`}
        onClick={() => onDecision(itemId, 'CERTIFY')}
        disabled={disabled}
        title="Certify this permission"
      >Yes</button>
      <button
        className={`item-action-btn item-action-revoke ${current === 'REVOKE' ? 'active' : ''}`}
        onClick={() => onDecision(itemId, 'REVOKE')}
        disabled={disabled}
        title="Revoke this permission"
      >No</button>
      <button
        className={`item-action-btn item-action-modify ${current === 'MODIFY' ? 'active' : ''}`}
        onClick={() => onDecision(itemId, 'MODIFY')}
        disabled={disabled}
        title="Request modification"
      >✎</button>
    </div>
  );
};

// S3 Access Detail View 

const S3AccessDetail = ({ accessInfo, decisions, onDecision, disabled }) => {
  const { bucketPolicy, publicAccessBlock, acl } = accessInfo;

  return (
    <div className="access-detail-sections">
      {/* Bucket Policy - per statement */}
      <div className="access-detail-section">
        <h5 className="access-detail-section-title">Bucket Policy Statements</h5>
        {bucketPolicy && bucketPolicy.Statement && bucketPolicy.Statement.length > 0 ? (
          <div className="policy-statements">
            {bucketPolicy.Statement.map((stmt, idx) => {
              const sid = stmt.Sid || `stmt-${idx}`;
              const actions = normalizeToArray(stmt.Action);
              return (
                <div key={sid} className="policy-item-row">
                  <div className="policy-item-detail">
                    <div className="policy-item-header">
                      <span className={`effect-badge effect-${stmt.Effect}`}>{stmt.Effect}</span>
                      <span className="policy-item-sid">{sid}</span>
                      <span className="policy-item-principal">> {formatPrincipal(stmt.Principal)}</span>
                    </div>
                    <div className="policy-item-actions-list">
                      {actions.map((action) => (
                        <span key={action} className="action-chip">{action}</span>
                      ))}
                    </div>
                    <div className="policy-item-resource">
                      Resource: {formatActions(stmt.Resource)}
                    </div>
                  </div>
                  <ItemActions itemId={`stmt:${sid}`} decisions={decisions} onDecision={onDecision} disabled={disabled} />
                </div>
              );
            })}
          </div>
        ) : (
          <p className="access-detail-empty">No bucket policy configured</p>
        )}
      </div>

      {/* Public Access Block */}
      <div className="access-detail-section">
        <h5 className="access-detail-section-title">Public Access Block</h5>
        {publicAccessBlock ? (
          <div className="policy-item-row">
            <div className="policy-item-detail">
              <div className="pab-grid">
                <span className="pab-item">{publicAccessBlock.BlockPublicAcls ? '✅' : '❌'} BlockPublicAcls</span>
                <span className="pab-item">{publicAccessBlock.IgnorePublicAcls ? '✅' : '❌'} IgnorePublicAcls</span>
                <span className="pab-item">{publicAccessBlock.BlockPublicPolicy ? '✅' : '❌'} BlockPublicPolicy</span>
                <span className="pab-item">{publicAccessBlock.RestrictPublicBuckets ? '✅' : '❌'} RestrictPublicBuckets</span>
              </div>
            </div>
            <ItemActions itemId="pab:all" decisions={decisions} onDecision={onDecision} disabled={disabled} />
          </div>
        ) : (
          <p className="access-detail-empty">Not configured (public access may be open)</p>
        )}
      </div>

      {/* ACL Grants - per grant */}
      <div className="access-detail-section">
        <h5 className="access-detail-section-title">ACL Grants</h5>
        {acl && acl.Grants && acl.Grants.length > 0 ? (
          <div className="policy-statements">
            {acl.Grants.map((grant, idx) => {
              const granteeId = grant.Grantee?.URI || grant.Grantee?.ID || `grant-${idx}`;
              const isOwner = grant.Grantee?.ID === acl.Owner?.ID;
              return (
                <div key={idx} className="policy-item-row">
                  <div className="policy-item-detail">
                    <span className="action-chip">{grant.Permission}</span>
                    <span className="policy-item-principal">
                      {grant.Grantee?.URI || grant.Grantee?.DisplayName || grant.Grantee?.ID || '-'}
                      {isOwner && <span className="owner-badge">Owner</span>}
                    </span>
                  </div>
                  {!isOwner && (
                    <ItemActions itemId={`acl:${granteeId}`} decisions={decisions} onDecision={onDecision} disabled={disabled} />
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="access-detail-empty">No ACL grants</p>
        )}
      </div>
    </div>
  );
};

// IAM Access Detail View 

const IamAccessDetail = ({ accessInfo, decisions, onDecision, disabled }) => {
  const { attachedPolicies, inlinePolicies, groups, accessKeys } = accessInfo;

  return (
    <div className="access-detail-sections">
      {/* Managed Policies - per policy */}
      <div className="access-detail-section">
        <h5 className="access-detail-section-title">Managed Policies</h5>
        {attachedPolicies && attachedPolicies.length > 0 ? (
          <div className="policy-statements">
            {attachedPolicies.map((p) => (
              <div key={p.PolicyArn} className="policy-item-row">
                <div className="policy-item-detail">
                  <span className="policy-name">{p.PolicyName}</span>
                  <span className="policy-arn">{p.PolicyArn}</span>
                </div>
                <ItemActions itemId={`policy:${p.PolicyArn}`} decisions={decisions} onDecision={onDecision} disabled={disabled} />
              </div>
            ))}
          </div>
        ) : (
          <p className="access-detail-empty">No managed policies</p>
        )}
      </div>

      {/* Inline Policies */}
      {inlinePolicies && inlinePolicies.length > 0 && (
        <div className="access-detail-section">
          <h5 className="access-detail-section-title">Inline Policies</h5>
          <div className="policy-statements">
            {inlinePolicies.map((name) => (
              <div key={name} className="policy-item-row">
                <div className="policy-item-detail">
                  <span className="policy-name">{name}</span>
                </div>
                <ItemActions itemId={`inline:${name}`} decisions={decisions} onDecision={onDecision} disabled={disabled} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Group Memberships - per group */}
      <div className="access-detail-section">
        <h5 className="access-detail-section-title">Group Memberships</h5>
        {groups && groups.length > 0 ? (
          <div className="policy-statements">
            {groups.map((g) => (
              <div key={g.GroupName} className="policy-item-row">
                <div className="policy-item-detail">
                  <span className="policy-name">{g.GroupName}</span>
                </div>
                <ItemActions itemId={`group:${g.GroupName}`} decisions={decisions} onDecision={onDecision} disabled={disabled} />
              </div>
            ))}
          </div>
        ) : (
          <p className="access-detail-empty">No group memberships</p>
        )}
      </div>

      {/* Access Keys - per key */}
      <div className="access-detail-section">
        <h5 className="access-detail-section-title">Access Keys</h5>
        {accessKeys && accessKeys.length > 0 ? (
          <div className="policy-statements">
            {accessKeys.map((key) => (
              <div key={key.AccessKeyId} className="policy-item-row">
                <div className="policy-item-detail">
                  <span className="key-id-masked">{maskAccessKeyId(key.AccessKeyId)}</span>
                  <span className={`key-status key-status-${key.Status}`}>{key.Status}</span>
                  <span className="policy-arn">Created: {fmtDate(key.CreateDate)}</span>
                </div>
                {key.Status === 'Active' && (
                  <ItemActions itemId={`key:${key.AccessKeyId}`} decisions={decisions} onDecision={onDecision} disabled={disabled} />
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="access-detail-empty">No access keys</p>
        )}
      </div>
    </div>
  );
};

// Helpers 

const normalizeToArray = (val) => {
  if (!val) return [];
  if (typeof val === 'string') return [val];
  if (Array.isArray(val)) return val;
  return [String(val)];
};

const formatPrincipal = (principal) => {
  if (!principal) return '*';
  if (typeof principal === 'string') return principal;
  if (principal.AWS) return Array.isArray(principal.AWS) ? principal.AWS.join(', ') : principal.AWS;
  if (principal.Service) return Array.isArray(principal.Service) ? principal.Service.join(', ') : principal.Service;
  return JSON.stringify(principal);
};

const formatActions = (actions) => {
  if (!actions) return '-';
  if (typeof actions === 'string') return actions;
  if (Array.isArray(actions)) return actions.join(', ');
  return JSON.stringify(actions);
};

// Main Component 

/**
 * AccessDetailPanel with per-item decision support.
 * @param {Object} props
 * @param {Object} props.accessInfo - Resource access details
 * @param {string} props.service - Service type (s3, iam)
 * @param {Object} [props.itemDecisions] - Per-item decisions from parent { itemId: 'CERTIFY'|'REVOKE'|'MODIFY' }
 * @param {Function} [props.onItemDecision] - Callback (itemId, decision) for per-item actions
 * @param {boolean} [props.disabled] - Disable actions (e.g., already submitted)
 */
const AccessDetailPanel = ({ accessInfo, service, itemDecisions = {}, onItemDecision, disabled = false }) => {
  // Use internal state if no external control provided
  const [localDecisions, setLocalDecisions] = useState({});
  const decisions = onItemDecision ? itemDecisions : localDecisions;
  const handleDecision = onItemDecision || ((itemId, decision) => {
    setLocalDecisions((prev) => {
      if (prev[itemId] === decision) {
        const next = { ...prev };
        delete next[itemId];
        return next;
      }
      return { ...prev, [itemId]: decision };
    });
  });

  if (!accessInfo || Object.keys(accessInfo).length === 0) {
    return (
      <div className="access-detail-panel">
        <p className="access-detail-unavailable">Access details unavailable</p>
      </div>
    );
  }

  const isS3 = service === 's3';
  const isIam = service === 'iam' || service === 'iam:user';

  // Summary bar
  const totalItems = Object.keys(decisions).length;
  const certifyCount = Object.values(decisions).filter((d) => d === 'CERTIFY').length;
  const revokeCount = Object.values(decisions).filter((d) => d === 'REVOKE').length;
  const modifyCount = Object.values(decisions).filter((d) => d === 'MODIFY').length;

  return (
    <div className="access-detail-panel">
      {totalItems > 0 && (
        <div className="item-decision-summary">
          {certifyCount > 0 && <span className="summary-certify">Yes {certifyCount} certified</span>}
          {revokeCount > 0 && <span className="summary-revoke">No {revokeCount} to revoke</span>}
          {modifyCount > 0 && <span className="summary-modify">✎ {modifyCount} to modify</span>}
        </div>
      )}
      {isS3 && <S3AccessDetail accessInfo={accessInfo} decisions={decisions} onDecision={handleDecision} disabled={disabled} />}
      {isIam && <IamAccessDetail accessInfo={accessInfo} decisions={decisions} onDecision={handleDecision} disabled={disabled} />}
      {!isS3 && !isIam && (
        <p className="access-detail-unavailable">Access details not supported for this resource type</p>
      )}
    </div>
  );
};

export default AccessDetailPanel;
