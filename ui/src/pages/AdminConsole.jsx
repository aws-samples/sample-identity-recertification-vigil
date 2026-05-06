/**
 * Admin Console - unowned resources, override management, cycle management.
 * Accessible to users in the "admin" Cognito group.
 * @module pages/AdminConsole
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getUnownedResources, getOverrides, createOverride,
  deleteOverride, triggerCycle, getAccounts, syncAccounts, scanAccount,
} from '../utils/api.js';
import AccountSelector from '../components/AccountSelector.jsx';
import './AdminConsole.css';

const TABS = ['Unowned Resources', 'Override Assignments', 'Cycle Management', 'Accounts'];

const AdminConsole = () => {
  const [activeTab, setActiveTab] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [unowned, setUnowned] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [unownedRes, overridesRes] = await Promise.all([
        getUnownedResources().catch(() => ({ data: { unownedResources: [] } })),
        getOverrides().catch(() => ({ data: { overrides: [] } })),
      ]);
      setUnowned((unownedRes.data || unownedRes).unownedResources || []);
      setOverrides((overridesRes.data || overridesRes).overrides || []);
    } catch (err) {
      setError(err.message || 'Failed to load admin data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Filter unowned resources by selected account
  const filteredUnowned = selectedAccountId
    ? unowned.filter((r) => r.accountId === selectedAccountId)
    : unowned;

  if (loading) return <div className="admin-loading">Loading admin console...</div>;
  if (error) return <div className="admin-error"><p>{error}</p><button onClick={loadData}>Retry</button></div>;

  return (
    <div className="admin-console">
      <div className="admin-header">
        <h1 className="admin-title">Admin Console</h1>
        <p className="admin-subtitle">Manage unowned resources, overrides, and recertification cycles</p>
      </div>
      <div className="admin-tabs">
        {TABS.map((tab, i) => (
          <button key={tab} className={`admin-tab ${activeTab === i ? 'admin-tab--active' : ''}`} onClick={() => setActiveTab(i)}>
            {tab}
          </button>
        ))}
      </div>
      {activeTab === 0 && <UnownedTab unowned={filteredUnowned} onReload={loadData} selectedAccountId={selectedAccountId} onAccountChange={setSelectedAccountId} />}
      {activeTab === 1 && <OverridesTab overrides={overrides} onReload={loadData} />}
      {activeTab === 2 && <CycleManagementTab />}
      {activeTab === 3 && <AccountsTab />}
    </div>
  );
};

// Unowned Resources Tab 

const UnownedTab = ({ unowned, onReload, selectedAccountId, onAccountChange }) => {
  const [assignEmail, setAssignEmail] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSynced, setLastSynced] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [scanning, setScanning] = useState(false);

  // Extract lastSyncedAt from the unowned data if available
  useEffect(() => {
    // The API now returns lastSyncedAt in the response
    // We'll fetch it on mount
    const fetchSyncStatus = async () => {
      try {
        const res = await getUnownedResources();
        const data = res.data || res;
        if (data.lastSyncedAt) {
          setLastSynced(data.lastSyncedAt);
        }
      } catch { /* ignore */ }
    };
    fetchSyncStatus();
  }, [unowned]);

  const handleRefreshNow = async () => {
    setRefreshing(true);
    setFeedback(null);
    try {
      await triggerCycle('QUARTERLY', { type: 'ALL' });
      setFeedback('Refresh triggered. Resource scan in progress...');
      // Reload after a short delay to allow cache to update
      setTimeout(async () => {
        await onReload();
        setRefreshing(false);
      }, 3000);
    } catch (err) {
      setFeedback(`Error: ${err.message}`);
      setRefreshing(false);
    }
  };

  const handleSyncAccounts = async () => {
    setSyncing(true);
    setFeedback(null);
    try {
      await syncAccounts();
      setFeedback('Account sync completed successfully.');
      await onReload();
    } catch (err) {
      setFeedback(`Error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleScanAccount = async () => {
    if (!selectedAccountId) return;
    setScanning(true);
    setFeedback(null);
    try {
      const res = await scanAccount(selectedAccountId);
      const data = res.data || res;
      const count = data.resources?.length || 0;
      setFeedback(`Scan complete: ${count} resources found in account ${selectedAccountId}.`);
      await onReload();
    } catch (err) {
      setFeedback(`Error: ${err.message}`);
    } finally {
      setScanning(false);
    }
  };

  const handleAssign = async () => {
    if (!assignEmail || selected.size === 0) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const resources = unowned
        .filter((r) => selected.has(resourceKey(r)))
        .map((r) => ({ resourceArn: r.arn || r.resourceArn, resourceType: r.resourceType || 'unknown', reason: 'Admin assignment' }));
      await createOverride(assignEmail, resources);
      setSelected(new Set());
      setAssignEmail('');
      setFeedback(`Assigned ${resources.length} resources to ${assignEmail}`);
      await onReload();
    } catch (err) {
      setFeedback(`Error: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleSelect = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  if (unowned.length === 0) return (
    <div className="admin-section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <AccountSelector value={selectedAccountId} onChange={onAccountChange} />
        <button className="admin-btn admin-btn--secondary" disabled={syncing} onClick={handleSyncAccounts} style={{ fontSize: 12 }}>
          {syncing ? '⏳ Syncing...' : '🔄 Sync Accounts'}
        </button>
        <button className="admin-btn admin-btn--primary" disabled={!selectedAccountId || scanning} onClick={handleScanAccount} style={{ fontSize: 12 }}>
          {scanning ? '⏳ Scanning...' : '🔍 Scan Account'}
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="admin-empty" style={{ margin: 0 }}>No unowned resources found.</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {lastSynced && <span style={{ fontSize: 11, color: '#718096' }}>Last synced: {new Date(lastSynced).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>}
          <button className="admin-btn admin-btn--primary" disabled={refreshing} onClick={handleRefreshNow} style={{ fontSize: 12 }}>
            {refreshing ? '⏳ Refreshing...' : '🔄 Refresh Now'}
          </button>
        </div>
      </div>
      {feedback && <p style={{ fontSize: 13, color: feedback.startsWith('Error') ? '#d63031' : '#00b894' }}>{feedback}</p>}
    </div>
  );

  return (
    <div className="admin-section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <AccountSelector value={selectedAccountId} onChange={onAccountChange} />
        <button className="admin-btn admin-btn--secondary" disabled={syncing} onClick={handleSyncAccounts} style={{ fontSize: 12 }}>
          {syncing ? '⏳ Syncing...' : '🔄 Sync Accounts'}
        </button>
        <button className="admin-btn admin-btn--primary" disabled={!selectedAccountId || scanning} onClick={handleScanAccount} style={{ fontSize: 12 }}>
          {scanning ? '⏳ Scanning...' : '🔍 Scan Account'}
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 className="admin-section-title" style={{ margin: 0 }}>Unowned Resources ({unowned.length})</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {lastSynced && <span style={{ fontSize: 11, color: '#718096' }}>Last synced: {new Date(lastSynced).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>}
          <button className="admin-btn admin-btn--primary" disabled={refreshing} onClick={handleRefreshNow} style={{ fontSize: 12 }}>
            {refreshing ? '⏳ Refreshing...' : '🔄 Refresh Now'}
          </button>
        </div>
      </div>
      <div className="assign-form">
        <div>
          <label htmlFor="assign-email">Assign selected to owner</label>
          <input id="assign-email" type="email" placeholder="owner@example.com" value={assignEmail} onChange={(e) => setAssignEmail(e.target.value)} />
        </div>
        <button className="admin-btn admin-btn--primary" disabled={!assignEmail || selected.size === 0 || submitting} onClick={handleAssign}>
          {submitting ? 'Assigning...' : `Assign (${selected.size})`}
        </button>
      </div>
      {feedback && <p style={{ fontSize: 13, color: feedback.startsWith('Error') ? '#d63031' : '#00b894', marginBottom: 8 }}>{feedback}</p>}
      <div className="admin-resource-row" style={{ fontWeight: 600, borderBottom: '2px solid #e2e8f0' }}>
        <span>Resource</span><span>Type</span><span>Service</span><span>Select</span>
      </div>
      {unowned.map((r) => {
        const key = resourceKey(r);
        return (
          <div key={key} className="admin-resource-row" title={r.arn}>
            <span title={r.arn}>{r.resourceName || r.arn?.split(':').pop() || '-'}</span>
            <span>{r.resourceType || '-'}</span>
            <span>{r.service || '-'}</span>
            <span><input type="checkbox" checked={selected.has(key)} onChange={() => toggleSelect(key)} /></span>
          </div>
        );
      })}
    </div>
  );
};

// Overrides Tab 

const OverridesTab = ({ overrides, onReload }) => {
  const [deleting, setDeleting] = useState(null);

  const handleDelete = async (ownerEmail, userId) => {
    setDeleting(`${ownerEmail}#${userId}`);
    try {
      await deleteOverride(ownerEmail, userId);
      await onReload();
    } catch (err) {
      console.error('Delete override failed:', err);
    } finally {
      setDeleting(null);
    }
  };

  if (overrides.length === 0) return <div className="admin-empty">No override assignments found.</div>;

  return (
    <div className="admin-section">
      <h2 className="admin-section-title">Override Assignments</h2>
      {overrides.map((group) => (
        <div key={group.ownerEmail} className="override-group">
          <div className="override-group-header">
            {group.ownerEmail} ({(group.resources || []).length} resources)
          </div>
          {(group.resources || []).map((r) => (
            <div key={r.userId} className="admin-resource-row">
              <span>{r.userId}</span>
              <span>{r.identitySource}</span>
              <span>{r.reason || '-'}</span>
              <span>
                <button
                  className="admin-btn admin-btn--danger"
                  disabled={deleting === `${group.ownerEmail}#${r.userId}`}
                  onClick={() => handleDelete(group.ownerEmail, r.userId)}
                >
                  Remove
                </button>
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};

// Cycle Management Tab 

const CycleManagementTab = () => {
  const [scope, setScope] = useState('ALL');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [userIds, setUserIds] = useState('');
  const [deadline, setDeadline] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [quarterlySubmitting, setQuarterlySubmitting] = useState(false);
  const [quarterlyResult, setQuarterlyResult] = useState(null);

  const handleQuarterlyTrigger = async () => {
    setQuarterlySubmitting(true);
    setQuarterlyResult(null);
    try {
      const res = await triggerCycle('QUARTERLY', { type: 'ALL' });
      setQuarterlyResult({ success: true, data: res.data || res });
    } catch (err) {
      setQuarterlyResult({ success: false, error: err.message });
    } finally {
      setQuarterlySubmitting(false);
    }
  };

  const handleTrigger = async () => {
    setSubmitting(true);
    setResult(null);
    try {
      const scopeObj = buildScope(scope, ownerEmail, userIds);
      const res = await triggerCycle('AD_HOC', scopeObj, deadline || undefined);
      setResult({ success: true, data: res.data || res });
    } catch (err) {
      setResult({ success: false, error: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="admin-section">
      {/* Prominent quarterly trigger */}
      <div className="admin-card" style={{ marginBottom: 24, border: '2px solid #0984e3', background: '#f0f7ff' }}>
        <h2 className="admin-section-title" style={{ color: '#0984e3', marginTop: 0 }}>🔄 Discover & Certify AWS Resources</h2>
        <p style={{ fontSize: 13, color: '#636e72', marginBottom: 12 }}>
          Discovers all AWS resources (S3 buckets, EC2 instances, Lambda functions, RDS instances, DynamoDB tables, etc.)
          with an <code>owner</code> tag in your account via the Resource Groups Tagging API.
          Groups resources by owner email and creates a recertification cycle for each owner to certify or revoke access.
        </p>
        <button
          className="admin-btn"
          style={{ background: '#0984e3', color: '#fff', padding: '12px 32px', fontSize: 15, fontWeight: 600, border: 'none', borderRadius: 6, cursor: 'pointer' }}
          disabled={quarterlySubmitting}
          onClick={handleQuarterlyTrigger}
        >
          {quarterlySubmitting ? '⏳ Discovering AWS resources & creating cycle...' : '🚀 Discover & Certify Resources'}
        </button>
        {quarterlyResult && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 6, background: quarterlyResult.success ? '#e8f8f0' : '#fde8e8' }}>
            {quarterlyResult.success ? (
              <div>
                <p style={{ fontSize: 14, color: '#00b894', fontWeight: 600, margin: 0 }}>
                  ✅ Cycle initiated: {quarterlyResult.data?.cycleId}
                </p>
                <p style={{ fontSize: 12, color: '#636e72', margin: '4px 0 0' }}>
                  {quarterlyResult.data?.totalResources || quarterlyResult.data?.totalUsers || 0} resources discovered across {quarterlyResult.data?.totalOwners || 0} owners
                  {quarterlyResult.data?.totalUnownedResources > 0 && ` (${quarterlyResult.data.totalUnownedResources} unowned)`}
                </p>
              </div>
            ) : (
              <p style={{ fontSize: 13, color: '#d63031', margin: 0 }}>❌ {quarterlyResult.error}</p>
            )}
          </div>
        )}
      </div>

      <h2 className="admin-section-title">Trigger Ad-Hoc Cycle</h2>
      <div className="admin-card">
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: '#636e72', display: 'block', marginBottom: 4 }}>Scope</label>
          <select value={scope} onChange={(e) => setScope(e.target.value)} style={{ padding: '6px 10px', border: '1px solid #dfe6e9', borderRadius: 4, fontSize: 13 }}>
            <option value="ALL">All Resources</option>
            <option value="OWNER">Specific Owner</option>
            <option value="RESOURCES">Specific Resources</option>
          </select>
        </div>
        {scope === 'OWNER' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: '#636e72', display: 'block', marginBottom: 4 }}>Owner Email</label>
            <input type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="owner@example.com" style={{ padding: '6px 10px', border: '1px solid #dfe6e9', borderRadius: 4, fontSize: 13, width: '100%' }} />
          </div>
        )}
        {scope === 'RESOURCES' && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: '#636e72', display: 'block', marginBottom: 4 }}>User IDs (comma-separated)</label>
            <input type="text" value={userIds} onChange={(e) => setUserIds(e.target.value)} placeholder="user-1, user-2" style={{ padding: '6px 10px', border: '1px solid #dfe6e9', borderRadius: 4, fontSize: 13, width: '100%' }} />
          </div>
        )}
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: '#636e72', display: 'block', marginBottom: 4 }}>Custom Deadline (optional)</label>
          <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} style={{ padding: '6px 10px', border: '1px solid #dfe6e9', borderRadius: 4, fontSize: 13 }} />
        </div>
        <button className="admin-btn admin-btn--primary" disabled={submitting} onClick={handleTrigger}>
          {submitting ? 'Triggering...' : 'Trigger Ad-Hoc Cycle'}
        </button>
        {result && (
          <p style={{ marginTop: 8, fontSize: 13, color: result.success ? '#00b894' : '#d63031' }}>
            {result.success ? `Cycle initiated: ${result.data?.cycleId || 'OK'}` : result.error}
          </p>
        )}
      </div>
    </div>
  );
};

// Accounts Tab 

const AccountsTab = () => {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAccounts();
      const data = res.data || res;
      setAccounts(data.accounts || []);
    } catch {
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  const handleSync = async () => {
    setSyncing(true);
    setFeedback(null);
    try {
      const res = await syncAccounts();
      const data = res.data || res;
      setAccounts(data.accounts || []);
      setFeedback('Account sync completed successfully.');
    } catch (err) {
      setFeedback(`Error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return <div className="admin-loading">Loading accounts...</div>;

  return (
    <div className="admin-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 className="admin-section-title" style={{ margin: 0 }}>Discovered Accounts ({accounts.length})</h2>
        <button className="admin-btn admin-btn--primary" disabled={syncing} onClick={handleSync}>
          {syncing ? '⏳ Syncing...' : '🔄 Sync from Organizations'}
        </button>
      </div>
      {feedback && <p style={{ fontSize: 13, color: feedback.startsWith('Error') ? '#d63031' : '#00b894', marginBottom: 8 }}>{feedback}</p>}
      {accounts.length === 0 ? (
        <div className="admin-empty">No accounts discovered. Click "Sync from Organizations" to discover member accounts.</div>
      ) : (
        <>
          <div className="admin-resource-row" style={{ fontWeight: 600, borderBottom: '2px solid #dfe6e9', gridTemplateColumns: '1fr 1fr 1fr 100px 140px' }}>
            <span>Account ID</span><span>Name</span><span>Email</span><span>Status</span><span>Last Synced</span>
          </div>
          {accounts.map((acct) => (
            <div key={acct.accountId} className="admin-resource-row" style={{ gridTemplateColumns: '1fr 1fr 1fr 100px 140px' }}>
              <span title={acct.accountId}>{acct.accountId}</span>
              <span title={acct.accountName}>{acct.accountName || '-'}</span>
              <span title={acct.email}>{acct.email || '-'}</span>
              <span>
                <span style={{
                  display: 'inline-block',
                  padding: '2px 8px',
                  borderRadius: 3,
                  fontSize: 11,
                  fontWeight: 600,
                  background: acct.status === 'ACTIVE' ? '#ecfdf5' : '#fef2f2',
                  color: acct.status === 'ACTIVE' ? '#059669' : '#dc2626',
                }}>
                  {acct.status}
                </span>
              </span>
              <span style={{ fontSize: 11, color: '#718096' }}>
                {acct.lastSyncedAt ? new Date(acct.lastSyncedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '-'}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
};

// Helpers 

const resourceKey = (r) => r.arn || r.resourceArn || `${r.identitySource}#${r.userId}`;

const buildScope = (type, ownerEmail, userIds) => {
  if (type === 'OWNER') return { type: 'OWNER', ownerEmail };
  if (type === 'RESOURCES') {
    const ids = userIds.split(',').map((s) => s.trim()).filter(Boolean);
    return { type: 'RESOURCES', userIds: ids };
  }
  return { type: 'ALL' };
};

export default AdminConsole;
