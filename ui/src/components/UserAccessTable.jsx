/**
 * UserAccessTable - Per-principal access table for resource recertification.
 * Shows all principals with access to a resource with per-user certify/revoke/modify actions.
 * @module components/UserAccessTable
 */

import { useState, useCallback } from 'react';

const REVOKE_REASONS = ['Unnecessary access', 'Security concern', 'Resource decommissioned', 'Policy violation', 'Other'];

const PRINCIPAL_TYPE_COLORS = {
  IAM_USER: '#0984e3',
  IAM_ROLE: '#6c5ce7',
  AWS_SERVICE: '#00b894',
  AWS_ACCOUNT: '#e17055',
  HISTORICAL: '#636e72',
};

const ACCESS_SOURCE_COLORS = {
  IAM_POLICY: '#0984e3',
  BUCKET_POLICY: '#6c5ce7',
  ACL: '#00b894',
  IAM_GROUP: '#e17055',
  HISTORICAL: '#636e72',
};

const SORT_OPTIONS = [
  { key: 'accessCount', label: 'Access Count' },
  { key: 'lastAccessed', label: 'Last Accessed' },
  { key: 'principalName', label: 'Name' },
];

/** Format timestamp for display */
const fmtDate = (iso) => {
  if (!iso) return null;
  try { return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }); } catch { return iso; }
};

/** Color code for access count */
const getAccessCountColor = (count) => {
  if (count === 0) return '#d63031';
  if (count <= 10) return '#fdcb6e';
  return '#00b894';
};

/** Extract resource name from an ARN (last segment after / or :) */
const extractResourceName = (arn) => {
  if (!arn) return '';
  const slashIdx = arn.lastIndexOf('/');
  if (slashIdx !== -1) return arn.substring(slashIdx + 1);
  const colonIdx = arn.lastIndexOf(':');
  if (colonIdx !== -1) return arn.substring(colonIdx + 1);
  return arn;
};

// Sort Logic 

const sortEntries = (entries, sortBy) => {
  const sorted = [...entries];
  sorted.sort((a, b) => {
    if (sortBy === 'accessCount') return b.accessCount - a.accessCount;
    if (sortBy === 'lastAccessed') {
      if (!a.lastAccessed && !b.lastAccessed) return 0;
      if (!a.lastAccessed) return 1;
      if (!b.lastAccessed) return -1;
      return new Date(b.lastAccessed) - new Date(a.lastAccessed);
    }
    if (sortBy === 'principalName') return (a.principalName || '').localeCompare(b.principalName || '');
    return 0;
  });
  return sorted;
};

// Main Component 

/**
 * @param {Object} props
 * @param {Array} props.accessEntries - Array of AccessEntry objects
 * @param {Function} props.onDecisionsChange - Callback with per-principal decisions Map
 * @param {boolean} [props.disabled] - Disable actions (already submitted)
 */
const UserAccessTable = ({ accessEntries = [], onDecisionsChange, disabled = false }) => {
  const [decisions, setDecisions] = useState({});
  const [sortBy, setSortBy] = useState('accessCount');
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [modifyTarget, setModifyTarget] = useState(null);

  const updateDecisions = useCallback((newDecisions) => {
    setDecisions(newDecisions);
    if (onDecisionsChange) {
      onDecisionsChange(newDecisions);
    }
  }, [onDecisionsChange]);

  const handleCertify = (principalArn) => {
    const next = { ...decisions, [principalArn]: { decision: 'CERTIFIED' } };
    updateDecisions(next);
  };

  const handleRevoke = (entry) => {
    setRevokeTarget(entry);
  };

  const confirmRevoke = (reason) => {
    if (!revokeTarget) return;
    const next = { ...decisions, [revokeTarget.principalArn]: { decision: 'REVOKED', reason } };
    updateDecisions(next);
    setRevokeTarget(null);
  };

  const handleModify = (entry) => {
    setModifyTarget(entry);
  };

  const confirmModify = (description) => {
    if (!modifyTarget) return;
    const next = { ...decisions, [modifyTarget.principalArn]: { decision: 'MODIFIED', reason: description } };
    updateDecisions(next);
    setModifyTarget(null);
  };

  const handleBulkCertify = () => {
    const next = { ...decisions };
    for (const entry of accessEntries) {
      if (!next[entry.principalArn]) {
        next[entry.principalArn] = { decision: 'CERTIFIED' };
      }
    }
    updateDecisions(next);
  };

  const sorted = sortEntries(accessEntries, sortBy);
  const decidedCount = Object.keys(decisions).length;
  const totalCount = accessEntries.length;
  const certifiedCount = Object.values(decisions).filter((d) => d.decision === 'CERTIFIED').length;
  const revokedCount = Object.values(decisions).filter((d) => d.decision === 'REVOKED').length;
  const modifiedCount = Object.values(decisions).filter((d) => d.decision === 'MODIFIED').length;

  return (
    <div className="user-access-table-container">
      {/* Summary Bar */}
      <div className="uat-summary-bar">
        <span className="uat-summary-text">
          {decidedCount} of {totalCount} principals decided
          {decidedCount > 0 && (
            <span className="uat-summary-breakdown">
              {certifiedCount > 0 && <span className="uat-summary-certified"> ({certifiedCount} certified</span>}
              {revokedCount > 0 && <span className="uat-summary-revoked">, {revokedCount} revoked</span>}
              {modifiedCount > 0 && <span className="uat-summary-modified">, {modifiedCount} modified</span>}
              {certifiedCount > 0 && <span>)</span>}
            </span>
          )}
        </span>
        <button
          className="uat-bulk-certify-btn"
          onClick={handleBulkCertify}
          disabled={disabled || decidedCount >= totalCount}
        >
          Certify All
        </button>
      </div>

      {/* Sort Controls */}
      <div className="uat-sort-controls">
        <span className="uat-sort-label">Sort by:</span>
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            className={`uat-sort-btn ${sortBy === opt.key ? 'active' : ''}`}
            onClick={() => setSortBy(opt.key)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="uat-table-wrapper">
        <table className="uat-table">
          <thead>
            <tr>
              <th>Principal Name</th>
              <th>Type</th>
              <th>Access Source</th>
              <th>Permissions</th>
              <th>Last Accessed</th>
              <th>Access Count</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => {
              const decision = decisions[entry.principalArn];
              const isDecided = !!decision;
              return (
                <tr key={entry.principalArn} className={isDecided ? `uat-row-decided uat-row-${decision.decision.toLowerCase()}` : ''}>
                  <td title={entry.principalArn} className="uat-principal-name">
                    {entry.principalType === 'AWS_SERVICE' && entry.sourceArn ? (
                      <span className="uat-service-principal">
                        <span>{entry.principalName || '-'}</span>
                        <span className="uat-source-arn" title={entry.sourceArn}>
                          > {extractResourceName(entry.sourceArn)}
                        </span>
                        {entry.sourceOwner && (
                          <span className="uat-source-owner">(owner: {entry.sourceOwner})</span>
                        )}
                      </span>
                    ) : (
                      entry.principalName || '-'
                    )}
                  </td>
                  <td>
                    <span
                      className="uat-badge"
                      style={{ background: PRINCIPAL_TYPE_COLORS[entry.principalType] || '#636e72' }}
                    >
                      {entry.principalType || '-'}
                    </span>
                  </td>
                  <td>
                    <span
                      className="uat-badge"
                      style={{ background: ACCESS_SOURCE_COLORS[entry.accessSource] || '#636e72' }}
                    >
                      {entry.accessSource || '-'}
                    </span>
                  </td>
                  <td className="uat-permissions-cell">
                    {entry.permissions && entry.permissions.length > 0 ? (
                      <div className="uat-permissions-chips">
                        {[...new Set(entry.permissions)].map((perm) => (
                          <span key={perm} className="uat-permission-chip">{perm}</span>
                        ))}
                      </div>
                    ) : (
                      <span className="uat-no-permissions">No active permissions</span>
                    )}
                  </td>
                  <td>
                    {entry.lastAccessed ? (
                      <span className="uat-last-accessed">{fmtDate(entry.lastAccessed)}</span>
                    ) : (
                      <span className="uat-never-accessed">⚠️ Never accessed</span>
                    )}
                  </td>
                  <td>
                    <span
                      className="uat-access-count"
                      style={{ color: getAccessCountColor(entry.accessCount) }}
                    >
                      {entry.accessCount}
                    </span>
                  </td>
                  <td>
                    {!isDecided ? (
                      <div className="uat-actions">
                        <button
                          className="uat-btn-certify"
                          onClick={() => handleCertify(entry.principalArn)}
                          disabled={disabled}
                          title="Certify access"
                        >Yes</button>
                        <button
                          className="uat-btn-revoke"
                          onClick={() => handleRevoke(entry)}
                          disabled={disabled}
                          title="Revoke access"
                        >No</button>
                        <button
                          className="uat-btn-modify"
                          onClick={() => handleModify(entry)}
                          disabled={disabled}
                          title="Request modification"
                        >✎</button>
                      </div>
                    ) : (
                      <span className={`uat-decision-badge uat-decision-${decision.decision.toLowerCase()}`}>
                        {decision.decision}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Inline Revoke Confirmation */}
      {revokeTarget && (
        <RevokeConfirmation
          entry={revokeTarget}
          onConfirm={confirmRevoke}
          onCancel={() => setRevokeTarget(null)}
        />
      )}

      {/* Inline Modify Confirmation */}
      {modifyTarget && (
        <ModifyConfirmation
          entry={modifyTarget}
          onConfirm={confirmModify}
          onCancel={() => setModifyTarget(null)}
        />
      )}
    </div>
  );
};

// Revoke Confirmation 

const RevokeConfirmation = ({ entry, onConfirm, onCancel }) => {
  const [reason, setReason] = useState('');

  return (
    <div className="uat-revoke-confirm">
      <div className="uat-revoke-confirm-content">
        <p className="uat-revoke-confirm-title">
          Revoke access for <strong>{entry.principalName}</strong>?
        </p>
        <p className="uat-revoke-confirm-detail">
          Permissions: {entry.permissions?.join(', ') || 'None'}
        </p>
        <div className="uat-revoke-confirm-field">
          <label>Reason (required)</label>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Select reason...</option>
            {REVOKE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="uat-revoke-confirm-actions">
          <button className="uat-revoke-cancel" onClick={onCancel}>Cancel</button>
          <button className="uat-revoke-submit" disabled={!reason} onClick={() => onConfirm(reason)}>
            Confirm Revoke
          </button>
        </div>
      </div>
    </div>
  );
};

// Modify Confirmation 

const ModifyConfirmation = ({ entry, onConfirm, onCancel }) => {
  // Deduplicate permissions
  const uniquePermissions = [...new Set(entry.permissions || [])];
  const [removedPerms, setRemovedPerms] = useState(new Set());

  const toggleRemove = (perm) => {
    setRemovedPerms((prev) => {
      const next = new Set(prev);
      next.has(perm) ? next.delete(perm) : next.add(perm);
      return next;
    });
  };

  const handleSubmit = () => {
    const removeList = [...removedPerms];
    const payload = JSON.stringify({ modifyActions: { remove: removeList } });
    onConfirm(payload);
  };

  return (
    <div className="uat-modify-confirm">
      <div className="uat-modify-confirm-content">
        <p className="uat-modify-confirm-title">
          Modify access for <strong>{entry.principalName}</strong>
        </p>
        <p className="uat-modify-confirm-detail">
          Select permissions to remove:
        </p>
        <div className="uat-modify-permissions-list">
          {uniquePermissions.map((perm) => {
            const isRemoved = removedPerms.has(perm);
            return (
              <span
                key={perm}
                className={`uat-modify-chip ${isRemoved ? 'uat-modify-chip--removed' : ''}`}
              >
                <span className="uat-modify-chip-label">{perm}</span>
                <button
                  className="uat-modify-chip-remove"
                  onClick={() => toggleRemove(perm)}
                  title={isRemoved ? 'Undo removal' : 'Mark for removal'}
                  type="button"
                >
                  No
                </button>
              </span>
            );
          })}
        </div>
        {removedPerms.size > 0 && (
          <p className="uat-modify-summary">
            {removedPerms.size} permission{removedPerms.size > 1 ? 's' : ''} marked for removal
          </p>
        )}
        <div className="uat-revoke-confirm-actions">
          <button className="uat-revoke-cancel" onClick={onCancel}>Cancel</button>
          <button
            className="uat-revoke-submit"
            style={{ background: '#fdcb6e', color: '#2d3436' }}
            disabled={removedPerms.size === 0}
            onClick={handleSubmit}
          >
            Submit Modification
          </button>
        </div>
      </div>
    </div>
  );
};

export default UserAccessTable;
