/**
 * User Detail page - tabbed view showing identity, lifecycle,
 * activity, recertification, and evidence for a single user.
 * @module pages/UserDetail
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import { getUserDetail } from '../utils/api.js';
import './UserDetail.css';

const TABS = [
  { key: 'identity', label: 'Identity' },
  { key: 'lifecycle', label: 'Lifecycle' },
  { key: 'activity', label: 'Activity' },
  { key: 'recertification', label: 'Recertification' },
  { key: 'evidence', label: 'Evidence' },
];

const LIFECYCLE_COLUMNS = [
  { key: 'eventType', label: 'Event', width: '110px' },
  { key: 'source', label: 'Source', width: '120px' },
  { key: 'actorId', label: 'Actor', width: '150px', render: (v) => v || '-' },
  {
    key: 'changedFields',
    label: 'Changed Fields',
    render: (v) => (Array.isArray(v) && v.length > 0 ? v.join(', ') : '-'),
  },
  {
    key: 'timestamp_ist',
    label: 'Timestamp (IST)',
    width: '180px',
    render: (v, row) => formatIST(v || row.createdAtIST || row.createdAt),
  },
];

const ACTIVITY_COLUMNS = [
  { key: 'date', label: 'Date', width: '120px' },
  { key: 'loginCount', label: 'Logins', width: '80px', render: (v) => v ?? 0 },
  { key: 'failedLogins', label: 'Failed', width: '80px', render: (v) => v ?? 0 },
  { key: 'uniqueIPs', label: 'Unique IPs', width: '100px', render: (v) => v ?? 0 },
  {
    key: 'lastLoginAt',
    label: 'Last Login (IST)',
    width: '180px',
    render: (v) => formatIST(v),
  },
];

const RECERT_COLUMNS = [
  { key: 'cycleId', label: 'Cycle', width: '140px' },
  { key: 'decision', label: 'Decision', width: '120px', render: (v) => renderDecision(v) },
  { key: 'decidedBy', label: 'Decided By', width: '150px', render: (v) => v || '-' },
  { key: 'justification', label: 'Justification', render: (v) => v || '-' },
  {
    key: 'decidedAt',
    label: 'Decided At (IST)',
    width: '180px',
    render: (v) => formatIST(v),
  },
];

const EVIDENCE_COLUMNS = [
  { key: 'eventType', label: 'Event', width: '110px' },
  { key: 'evidenceHash', label: 'SHA-256 Hash', render: (v) => truncate(v, 32) },
  {
    key: 'evidenceS3Key',
    label: 'S3 Key',
    render: (v) => v || '-',
  },
  {
    key: 'timestamp_ist',
    label: 'Timestamp (IST)',
    width: '180px',
    render: (v, row) => formatIST(v || row.createdAtIST || row.createdAt),
  },
];

/** Format IST timestamp */
const formatIST = (isoStr) => {
  if (!isoStr) return '-';
  try {
    return new Date(isoStr).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  } catch {
    return isoStr;
  }
};

/** Truncate string */
const truncate = (str, max) => {
  if (!str) return '-';
  return str.length > max ? str.slice(0, max) + '...' : str;
};

/** Render recert decision badge */
const renderDecision = (decision) => {
  if (!decision) return '-';
  const colorMap = {
    CERTIFIED: 'detail-badge--green',
    REVOKED: 'detail-badge--red',
    MODIFIED: 'detail-badge--blue',
    PENDING: 'detail-badge--yellow',
  };
  const cls = colorMap[decision] || '';
  return <span className={`detail-badge ${cls}`}>{decision}</span>;
};

/**
 * UserDetail page component.
 */
const UserDetail = () => {
  const { userId } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);
  const [activeTab, setActiveTab] = useState('identity');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getUserDetail(userId);
      setDetail(data.data || data);
    } catch (err) {
      setError(err.message || 'Failed to load user detail');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  if (loading) {
    return <div className="detail-loading">Loading user detail...</div>;
  }

  if (error) {
    return (
      <div className="detail-error">
        <p>Error: {error}</p>
        <button onClick={loadDetail}>Retry</button>
        <button onClick={() => navigate('/search')} style={{ marginLeft: 8 }}>Back to Search</button>
      </div>
    );
  }

  return (
    <div className="user-detail">
      {/* Header */}
      <div className="detail-header">
        <button className="back-btn" onClick={() => navigate('/search')}>Back</button>
        <div className="detail-header-info">
          <h1 className="detail-title">{detail?.identity?.email || userId}</h1>
          <span className="detail-user-id">ID: {userId}</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="detail-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`detail-tab ${activeTab === tab.key ? 'detail-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="detail-content">
        {activeTab === 'identity' && <IdentityTab data={detail?.identity} />}
        {activeTab === 'lifecycle' && <LifecycleTab data={detail?.lifecycle} />}
        {activeTab === 'activity' && <ActivityTab data={detail?.activity} />}
        {activeTab === 'recertification' && <RecertificationTab data={detail?.recertification} />}
        {activeTab === 'evidence' && <EvidenceTab data={detail?.lifecycle} />}
      </div>
    </div>
  );
};

// Tab components 

const IdentityTab = ({ data }) => {
  if (!data) return <p className="tab-empty">No identity data available</p>;

  const fields = [
    ['User ID', data.userId],
    ['Email', data.email],
    ['Name', data.userName || data.name],
    ['Identity Source', data.identitySource],
    ['Status', data.status],
    ['Created At (IST)', formatIST(data.createdAt)],
  ];

  return (
    <div className="identity-tab">
      <div className="info-grid">
        {fields.map(([label, value]) => (
          <div key={label} className="info-field">
            <span className="info-label">{label}</span>
            <span className="info-value">{value || '-'}</span>
          </div>
        ))}
      </div>

      {data.groups && data.groups.length > 0 && (
        <div className="info-section">
          <h3 className="info-section-title">Groups</h3>
          <div className="tag-list">
            {data.groups.map((g, i) => (
              <span key={i} className="tag">{typeof g === 'string' ? g : g.groupName || g.GroupName}</span>
            ))}
          </div>
        </div>
      )}

      {data.roles && data.roles.length > 0 && (
        <div className="info-section">
          <h3 className="info-section-title">Roles / Policies</h3>
          <div className="tag-list">
            {data.roles.map((r, i) => (
              <span key={i} className="tag">{typeof r === 'string' ? r : r.PolicyName || r.roleName}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const LifecycleTab = ({ data }) => {
  const events = Array.isArray(data) ? data : data?.events || [];
  return (
    <DataTable
      columns={LIFECYCLE_COLUMNS}
      data={events}
      pageSize={15}
      emptyMessage="No lifecycle events recorded"
    />
  );
};

const ActivityTab = ({ data }) => {
  const summaries = Array.isArray(data) ? data : data?.dailySummaries || data?.summaries || [];

  const lastLogin = data?.lastLoginAt || (summaries.length > 0 ? summaries[0]?.lastLoginAt : null);

  return (
    <div>
      {lastLogin && (
        <div className="activity-summary">
          <span className="info-label">Last Login (IST):</span>{' '}
          <span className="info-value">{formatIST(lastLogin)}</span>
        </div>
      )}
      <DataTable
        columns={ACTIVITY_COLUMNS}
        data={summaries}
        pageSize={15}
        emptyMessage="No activity data available"
      />
    </div>
  );
};

const RecertificationTab = ({ data }) => {
  const decisions = Array.isArray(data) ? data : data?.decisions || data?.history || [];
  return (
    <DataTable
      columns={RECERT_COLUMNS}
      data={decisions}
      pageSize={10}
      emptyMessage="No recertification history"
    />
  );
};

const EvidenceTab = ({ data }) => {
  const events = Array.isArray(data) ? data : data?.events || [];
  const withEvidence = events.filter((e) => e.evidenceHash || e.evidenceS3Key);
  return (
    <DataTable
      columns={EVIDENCE_COLUMNS}
      data={withEvidence}
      pageSize={15}
      emptyMessage="No evidence records linked"
    />
  );
};

export default UserDetail;
