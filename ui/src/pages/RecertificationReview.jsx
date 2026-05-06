/**
 * Owner Recertification Review Page - AWS Resource-Centric.
 * Resources grouped by service type (S3, EC2, Lambda, etc.) with certify/revoke/modify actions,
 * bulk certify with 2-second timer, progress indicator, and submit.
 * Also supports Designated Leader view (grouped by owner, act-on-behalf).
 * @module pages/RecertificationReview
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../components/AuthProvider.jsx';
import { getMyReviews, getCycleDetails, submitDecisions, requestExtension } from '../utils/api.js';
import AccessDetailPanel from '../components/AccessDetailPanel.jsx';
import UserAccessTable from '../components/UserAccessTable.jsx';
import PartialRevokeSelector from '../components/PartialRevokeSelector.jsx';
import AccountSelector from '../components/AccountSelector.jsx';
import './RecertificationReview.css';

const REVOKE_REASONS = ['Unnecessary access', 'Security concern', 'Resource decommissioned', 'Policy violation', 'Other'];
const SERVICE_LABELS = {
  s3: 'S3 Buckets', ec2: 'EC2 Instances', lambda: 'Lambda Functions',
  rds: 'RDS Instances', dynamodb: 'DynamoDB Tables', iam: 'IAM Resources',
  sns: 'SNS Topics', sqs: 'SQS Queues', unknown: 'Other Resources',
};
const SERVICE_ICONS = {
  s3: '🪣', ec2: '🖥️', lambda: 'λ', rds: '🗄️', dynamodb: '📊',
  iam: '🔑', sns: '📢', sqs: '📬', unknown: '📦',
};

/** Format date for display */
const fmtDate = (iso) => {
  if (!iso) return '-';
  try { return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }); } catch { return iso; }
};

// Main Component 

const RecertificationReview = () => {
  const { cycleId } = useParams();
  const { user } = useAuth();
  const isLeader = (user?.groups || []).includes('designated_leader');

  const [reviews, setReviews] = useState([]);
  const [cycle, setCycle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [principalDecisions, setPrincipalDecisions] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [modal, setModal] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [leaderActing, setLeaderActing] = useState(null);
  const [accountFilter, setAccountFilter] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isLeader && !leaderActing) {
        const res = await getCycleDetails(cycleId);
        const data = res.data || res;
        setCycle(data.cycle);
        setReviews(data.reviewItems || []);
      } else {
        const [reviewRes, cycleRes] = await Promise.all([
          getMyReviews(cycleId),
          getCycleDetails(cycleId).catch(() => null),
        ]);
        const rData = reviewRes.data || reviewRes;
        setReviews(rData.reviews || []);
        if (cycleRes) setCycle((cycleRes.data || cycleRes).cycle);
      }
    } catch (err) {
      setError(err.message || 'Failed to load reviews');
    } finally {
      setLoading(false);
    }
  }, [cycleId, isLeader, leaderActing]);

  useEffect(() => { loadData(); }, [loadData]);

  const resourceKey = (item) => item.resourceArn || item.userId || item.SK;

  const handleDecision = (key, decision, extra = {}) => {
    setDecisions((prev) => ({ ...prev, [key]: { decision, ...extra } }));
  };

  const handlePrincipalDecisionsChange = (resourceKey, perPrincipalDecisions) => {
    setPrincipalDecisions((prev) => ({ ...prev, [resourceKey]: perPrincipalDecisions }));
  };

  const groupedByService = groupByService(accountFilter ? reviews.filter((r) => r.accountId === accountFilter) : reviews);
  const groupedByOwner = isLeader && !leaderActing ? groupByOwnerEmail(accountFilter ? reviews.filter((r) => r.accountId === accountFilter) : reviews) : null;

  const totalResources = reviews.length;
  const decidedCount = (() => {
    let count = 0;
    for (const r of reviews) {
      const key = resourceKey(r);
      if (r.status !== 'PENDING') {
        count++;
      } else if (decisions[key]) {
        count++;
      } else if (r.accessEntries && Array.isArray(r.accessEntries) && r.accessEntries.length > 0) {
        // For resources with accessEntries, count as decided if all principals decided
        const perPrincipal = principalDecisions[key];
        if (perPrincipal && Object.keys(perPrincipal).length >= r.accessEntries.length) {
          count++;
        }
      }
    }
    return count;
  })();
  const allDecided = decidedCount >= totalResources;

  if (loading) return <div className="recert-loading">Loading resource reviews...</div>;
  if (error) return <div className="recert-error"><p>{error}</p><button onClick={loadData}>Retry</button></div>;
  if (reviews.length === 0) {
    return (
      <div className="recert-review">
        <div className="recert-empty">
          <span className="recert-empty-icon">✅</span>
          <h2>No Recertification Pending</h2>
          <p>You have no resources assigned for recertification review in cycle <strong>{cycleId}</strong>.</p>
          <p className="recert-empty-hint">If you believe this is an error, contact your IT Governance admin.</p>
        </div>
      </div>
    );
  }

  // Designated Leader View 
  if (isLeader && !leaderActing) {
    return (
      <div className="recert-review">
        <RecertHeader cycle={cycle} cycleId={cycleId} total={totalResources} decided={decidedCount} />
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Owner Groups</h2>
        {Object.entries(groupedByOwner || {}).map(([ownerEmail, items]) => (
          <div key={ownerEmail} className="leader-owner-group">
            <div className="leader-owner-header">
              <span className="leader-owner-name">{ownerEmail} ({items.length} resources)</span>
              <button className="act-behalf-btn" onClick={() => setLeaderActing(ownerEmail)}>Act on behalf</button>
            </div>
            <ResourceList items={items} decisions={{}} onDecision={() => {}} selected={new Set()} onSelect={() => {}} readOnly resourceKey={resourceKey} />
          </div>
        ))}
      </div>
    );
  }

  // Owner / Acting-on-behalf View 
  return (
    <div className="recert-review">
      <RecertHeader cycle={cycle} cycleId={cycleId} total={totalResources} decided={decidedCount} />
      {leaderActing && (
        <div style={{ background: '#dfe6e9', padding: '8px 12px', borderRadius: 4, marginBottom: 12, fontSize: 13 }}>
          Acting on behalf of <strong>{leaderActing}</strong>
          <button style={{ marginLeft: 12, fontSize: 12, cursor: 'pointer' }} onClick={() => setLeaderActing(null)}>Cancel</button>
        </div>
      )}
      <ActionsBar
        selected={selected}
        reviews={reviews}
        decisions={decisions}
        allDecided={allDecided}
        submitting={submitting}
        onBulkCertify={() => setModal({ type: 'BULK_CERTIFY' })}
        onSubmit={() => setModal({ type: 'SUBMIT_ALL' })}
        onExtend={() => setModal({ type: 'EXTEND' })}
        resourceKey={resourceKey}
      />
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <label style={{ fontSize: 12, color: '#4a5568', fontWeight: 500 }}>Filter by Account:</label>
        <AccountSelector value={accountFilter} onChange={setAccountFilter} />
      </div>
      {Object.entries(groupedByService).map(([service, items]) => (
        <div key={service} className="source-group">
          <h3 className="source-group-title">
            {SERVICE_ICONS[service] || '📦'} {SERVICE_LABELS[service] || service.toUpperCase()} ({items.length})
          </h3>
          <ResourceList
            items={items}
            decisions={decisions}
            onDecision={handleDecision}
            selected={selected}
            onSelect={(key) => setSelected((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; })}
            onRevoke={(item) => setModal({ type: 'REVOKE', item })}
            onModify={(item) => setModal({ type: 'MODIFY', item })}
            resourceKey={resourceKey}
            principalDecisions={principalDecisions}
            onPrincipalDecisionsChange={handlePrincipalDecisionsChange}
          />
        </div>
      ))}
      {modal && (
        <ModalRouter
          modal={modal}
          selected={selected}
          reviews={reviews}
          decisions={decisions}
          cycleId={cycleId}
          leaderActing={leaderActing}
          onDecision={handleDecision}
          onClose={() => setModal(null)}
          resourceKey={resourceKey}
          onSubmitAll={async () => {
            setSubmitting(true);
            try {
              const batch = buildDecisionBatch(reviews, decisions, resourceKey, principalDecisions);
              await submitDecisions(cycleId, batch, leaderActing || undefined);
              await loadData();
              setDecisions({});
              setPrincipalDecisions({});
              setSelected(new Set());
            } catch (err) {
              setError(err.message);
            } finally {
              setSubmitting(false);
              setModal(null);
            }
          }}
          onExtendSubmit={async (reason) => {
            try {
              await requestExtension(cycleId, reason);
              await loadData();
            } catch (err) {
              setError(err.message);
            }
            setModal(null);
          }}
        />
      )}
    </div>
  );
};

// Sub-components 

const RecertHeader = ({ cycle, cycleId, total, decided }) => {
  const pct = total > 0 ? Math.round((decided / total) * 100) : 0;
  return (
    <div className="recert-header">
      <h1 className="recert-title">{cycleId} AWS Resource Recertification</h1>
      <p className="recert-subtitle">Deadline: {cycle ? fmtDate(cycle.deadline) : '-'}</p>
      <div className="recert-progress">
        <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: `${pct}%` }} /></div>
        <span className="progress-text">{decided} of {total} resources reviewed ({pct}%)</span>
      </div>
    </div>
  );
};

const ActionsBar = ({ selected, reviews, decisions, allDecided, submitting, onBulkCertify, onSubmit, onExtend, resourceKey }) => {
  const pendingSelected = [...selected].filter((key) => {
    const r = reviews.find((rv) => resourceKey(rv) === key);
    return r?.status === 'PENDING' && !decisions[key];
  });
  return (
    <div className="recert-actions-bar">
      <button className="bulk-certify-btn" disabled={pendingSelected.length === 0} onClick={onBulkCertify}>
        Certify Selected ({pendingSelected.length})
      </button>
      <button className="submit-all-btn" disabled={!allDecided || submitting} onClick={onSubmit}>
        {submitting ? 'Submitting...' : 'Submit All Decisions'}
      </button>
      <button className="extend-btn" onClick={onExtend}>Request Extension</button>
    </div>
  );
};

const ResourceList = ({ items, decisions, onDecision, selected, onSelect, onRevoke, onModify, readOnly, resourceKey, principalDecisions, onPrincipalDecisionsChange }) => {
  const [expanded, setExpanded] = useState(new Set());

  const toggleExpand = (key) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  };

  return (
    <div>
      <div className="resource-row resource-row--header">
        <span style={{ width: 30 }} />
        <span style={{ width: 24 }} />
        <div className="resource-info resource-info--header">
          <span>Resource Name</span>
          <span>Type</span>
          <span>Account</span>
          <span>Owner</span>
          <span>Status</span>
        </div>
        <span style={{ width: 180 }}>Actions</span>
      </div>
      {items.map((item) => {
        const key = resourceKey(item);
        const decided = decisions[key] || (item.status !== 'PENDING' ? { decision: item.status } : null);
        const isPending = item.status === 'PENDING' && !decided;
        const isExpanded = expanded.has(key);
        const service = item.service || item.resourceType?.split(':')[0] || 'unknown';
        const hasAccessInfo = item.accessInfo && Object.keys(item.accessInfo).length > 0;
        const hasAccessEntries = item.accessEntries && Array.isArray(item.accessEntries) && item.accessEntries.length > 0;
        const hasExpandable = hasAccessEntries || hasAccessInfo;

        return (
          <div key={key}>
            <div className="resource-row" title={item.resourceArn || item.arn}>
              {!readOnly && <input type="checkbox" className="resource-checkbox" checked={selected.has(key)} onChange={() => onSelect(key)} disabled={!isPending || hasAccessEntries} />}
              {hasExpandable ? (
                <button className="expand-toggle" onClick={() => toggleExpand(key)} title="Toggle access details">
                  {isExpanded ? 'v' : '>'}
                </button>
              ) : (
                <span style={{ width: 24 }} />
              )}
              <div className="resource-info">
                <span title={item.resourceArn || item.arn}>{item.resourceName || item.resourceId || '-'}</span>
                <span>{item.resourceType || '-'}</span>
                <span title={item.accountId ? `${item.accountName || ''} (${item.accountId})` : '-'}>
                  {item.accountName ? `${item.accountName}` : item.accountId || '-'}
                </span>
                <span>{item.ownerEmail || '-'}</span>
                <span>
                  <StatusBadge status={decided?.decision || item.status} />
                </span>
              </div>
              {/* Hide resource-level action buttons for items with accessEntries (decisions are per-principal) */}
              {!readOnly && isPending && !hasAccessEntries && (
                <div className="resource-actions">
                  <button className="btn-certify" onClick={() => onDecision(key, 'CERTIFIED', { resourceType: item.resourceType })}>Certify</button>
                  <button className="btn-revoke" onClick={() => onRevoke?.(item)}>Revoke</button>
                  <button className="btn-modify" onClick={() => onModify?.(item)}>Modify</button>
                </div>
              )}
            </div>
            {isExpanded && hasAccessEntries && (
              <UserAccessTable
                accessEntries={item.accessEntries}
                onDecisionsChange={(d) => onPrincipalDecisionsChange?.(key, d)}
                disabled={!isPending}
              />
            )}
            {isExpanded && !hasAccessEntries && hasAccessInfo && (
              <AccessDetailPanel
                accessInfo={item.accessInfo}
                service={service}
                disabled={!isPending}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

const ModalRouter = ({ modal, selected, reviews, decisions, cycleId, leaderActing, onDecision, onClose, onSubmitAll, onExtendSubmit, resourceKey }) => {
  if (modal.type === 'REVOKE') return <RevokeModal item={modal.item} onConfirm={(reason, comment, extra = {}) => { onDecision(resourceKey(modal.item), 'REVOKED', { reason, comment, resourceType: modal.item.resourceType, ...extra }); onClose(); }} onClose={onClose} />;
  if (modal.type === 'MODIFY') return <ModifyModal item={modal.item} onConfirm={(changes, justification) => { onDecision(resourceKey(modal.item), 'MODIFIED', { reason: justification, comment: changes, resourceType: modal.item.resourceType }); onClose(); }} onClose={onClose} />;
  if (modal.type === 'BULK_CERTIFY') return <BulkCertifyModal selected={selected} reviews={reviews} decisions={decisions} onConfirm={(keys) => { keys.forEach((k) => { const r = reviews.find((rv) => resourceKey(rv) === k); onDecision(k, 'CERTIFIED', { resourceType: r?.resourceType }); }); onClose(); }} onClose={onClose} resourceKey={resourceKey} />;
  if (modal.type === 'SUBMIT_ALL') return <SubmitModal onConfirm={onSubmitAll} onClose={onClose} />;
  if (modal.type === 'EXTEND') return <ExtendModal onConfirm={onExtendSubmit} onClose={onClose} />;
  return null;
};

const RevokeModal = ({ item, onConfirm, onClose }) => {
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [revokeMode, setRevokeMode] = useState('full');
  const [partialRevoke, setPartialRevoke] = useState(null);

  const service = item.service || item.resourceType?.split(':')[0] || 'unknown';
  const hasAccessInfo = item.accessInfo && Object.keys(item.accessInfo).length > 0;
  const supportsPartial = hasAccessInfo && (service === 's3' || service === 'iam');

  const handleConfirm = () => {
    const extra = revokeMode === 'partial' && partialRevoke ? { partialRevoke } : {};
    onConfirm(reason, comment, extra);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Revoke Access - {item.resourceName || item.resourceId}</h3>
        <div className="modal-warning">
          {revokeMode === 'full'
            ? 'Full revocation will remove all access permissions for this resource.'
            : 'Partial revocation will remove only the selected permissions.'}
        </div>
        <p style={{ fontSize: 12, color: '#636e72' }}>ARN: {item.resourceArn || item.arn}</p>

        {supportsPartial && (
          <div className="revoke-mode-toggle">
            <button
              className={`revoke-mode-btn ${revokeMode === 'full' ? 'active' : ''}`}
              onClick={() => setRevokeMode('full')}
            >
              Full Revoke
            </button>
            <button
              className={`revoke-mode-btn ${revokeMode === 'partial' ? 'active' : ''}`}
              onClick={() => setRevokeMode('partial')}
            >
              Partial Revoke
            </button>
          </div>
        )}

        {revokeMode === 'partial' && supportsPartial && (
          <PartialRevokeSelector
            accessInfo={item.accessInfo}
            service={service}
            onSelectionChange={setPartialRevoke}
          />
        )}

        <div className="modal-field">
          <label>Reason (required)</label>
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Select reason...</option>
            {REVOKE_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="modal-field">
          <label>Comment (optional)</label>
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Additional context..." />
        </div>
        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose}>Cancel</button>
          <button className="modal-confirm danger" disabled={!reason} onClick={handleConfirm}>
            {revokeMode === 'partial' ? 'Revoke Selected' : 'Revoke All Access'}
          </button>
        </div>
      </div>
    </div>
  );
};

const ModifyModal = ({ item, onConfirm, onClose }) => {
  const [changes, setChanges] = useState('');
  const [justification, setJustification] = useState('');
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Request Modification - {item.resourceName || item.resourceId}</h3>
        <div className="modal-field">
          <label>Resource</label>
          <input readOnly value={`${item.resourceType} - ${item.resourceArn || item.arn || '-'}`} />
        </div>
        <div className="modal-field">
          <label>Current Tags</label>
          <input readOnly value={formatTags(item.tags)} />
        </div>
        <div className="modal-field">
          <label>Proposed Changes</label>
          <textarea value={changes} onChange={(e) => setChanges(e.target.value)} placeholder="Describe access changes needed..." />
        </div>
        <div className="modal-field">
          <label>Justification</label>
          <textarea value={justification} onChange={(e) => setJustification(e.target.value)} placeholder="Why is this change needed?" />
        </div>
        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose}>Cancel</button>
          <button className="modal-confirm" disabled={!changes || !justification} onClick={() => onConfirm(changes, justification)}>Submit Modification</button>
        </div>
      </div>
    </div>
  );
};

const BulkCertifyModal = ({ selected, reviews, decisions, onConfirm, onClose, resourceKey }) => {
  const keys = [...selected].filter((key) => {
    const r = reviews.find((rv) => resourceKey(rv) === key);
    return r?.status === 'PENDING' && !decisions[key];
  });
  const [timer, setTimer] = useState(keys.length * 2);
  const intervalRef = useRef(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setTimer((t) => { if (t <= 1) { clearInterval(intervalRef.current); return 0; } return t - 1; });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Bulk Certify Resources</h3>
        <p>You are certifying access for <strong>{keys.length}</strong> AWS resources. This action will be logged.</p>
        {timer > 0 && <p style={{ color: '#d63031', fontSize: 13 }}>Please wait {timer}s (minimum review time)...</p>}
        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose}>Cancel</button>
          <button className="modal-confirm" disabled={timer > 0} onClick={() => onConfirm(keys)}>
            {timer > 0 ? `Wait ${timer}s` : 'Confirm Certify All'}
          </button>
        </div>
      </div>
    </div>
  );
};

const SubmitModal = ({ onConfirm, onClose }) => (
  <div className="modal-overlay" onClick={onClose}>
    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
      <h3 className="modal-title">Submit All Decisions</h3>
      <div className="modal-warning">All decisions are final and cannot be undone. Revoked resources will generate IT admin tickets. This will be permanently logged.</div>
      <div className="modal-actions">
        <button className="modal-cancel" onClick={onClose}>Cancel</button>
        <button className="modal-confirm" onClick={onConfirm}>Confirm Submit</button>
      </div>
    </div>
  </div>
);

const ExtendModal = ({ onConfirm, onClose }) => {
  const [reason, setReason] = useState('');
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Request Deadline Extension</h3>
        <p style={{ fontSize: 13, color: '#636e72' }}>Maximum 7-day extension. One per owner per cycle.</p>
        <div className="modal-field">
          <label>Reason</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why do you need more time?" />
        </div>
        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose}>Cancel</button>
          <button className="modal-confirm" disabled={!reason} onClick={() => onConfirm(reason)}>Request Extension</button>
        </div>
      </div>
    </div>
  );
};

// Status Badge Component 

const StatusBadge = ({ status }) => {
  if (status === 'REVOCATION_IN_PROGRESS') {
    return (
      <span className="status-badge status-REVOCATION_IN_PROGRESS">
        <span className="revocation-spinner" />
        In Progress
      </span>
    );
  }

  if (status === 'REVOCATION_FAILED') {
    return (
      <span className="status-badge status-REVOCATION_FAILED" title="Automated revocation failed. Fallback ticket created.">
        Failed
      </span>
    );
  }

  if (status === 'PARTIAL_REVOKED') {
    return (
      <span className="status-badge status-PARTIAL_REVOKED">
        Partial Revoked
      </span>
    );
  }

  if (status === 'REVOKED') {
    return (
      <span className="status-badge status-REVOKED">
        Revoked
      </span>
    );
  }

  return (
    <span className={`status-badge status-${status}`}>{status}</span>
  );
};

// Helpers 

const formatTags = (tags) => {
  if (!tags || typeof tags !== 'object') return '-';
  const entries = Object.entries(tags).filter(([k]) => k !== 'owner');
  if (entries.length === 0) return '-';
  return entries.map(([k, v]) => `${k}=${v}`).join(', ');
};

const groupByService = (items) => {
  const map = {};
  for (const item of items) {
    const svc = item.service || item.resourceType?.split(':')[0] || 'unknown';
    if (!map[svc]) map[svc] = [];
    map[svc].push(item);
  }
  return map;
};

const groupByOwnerEmail = (items) => {
  const map = {};
  for (const item of items) {
    const key = item.ownerEmail || 'unknown';
    if (!map[key]) map[key] = [];
    map[key].push(item);
  }
  return map;
};

const buildDecisionBatch = (reviews, decisions, resourceKey, principalDecisions = {}) => {
  const batch = [];

  // Resource-level decisions (for items without accessEntries)
  for (const [key, d] of Object.entries(decisions)) {
    const review = reviews.find((r) => resourceKey(r) === key);
    const decision = {
      resourceArn: key,
      decision: d.decision,
      reason: d.reason || null,
      comment: d.comment || null,
      reviewDurationSeconds: 0,
      resourceType: d.resourceType || review?.resourceType || 'unknown',
    };
    if (d.partialRevoke) {
      decision.partialRevoke = d.partialRevoke;
    }
    batch.push(decision);
  }

  // Per-principal decisions (for items with accessEntries)
  for (const [resourceArn, perPrincipal] of Object.entries(principalDecisions)) {
    for (const [principalArn, d] of Object.entries(perPrincipal)) {
      batch.push({
        resourceArn,
        principalArn,
        decision: d.decision,
        reason: d.reason || null,
      });
    }
  }

  return batch;
};

export default RecertificationReview;
