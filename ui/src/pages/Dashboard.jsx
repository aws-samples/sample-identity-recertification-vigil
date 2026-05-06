/**
 * Main Dashboard page - summary cards, event timeline chart,
 * user distribution pie charts, and recent events table.
 * Designed for Indian compliance auditors and IT governance admins.
 * @module pages/Dashboard
 */

import { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import DataTable from '../components/DataTable.jsx';
import {
  getDashboardSummary,
  getDashboardTimeline,
  getDashboardDistribution,
  getAccounts,
} from '../utils/api.js';
import './Dashboard.css';

const EVENT_COLORS = {
  CREATED: '#00b894',
  MODIFIED: '#0984e3',
  DELETED: '#d63031',
  DISABLED: '#fdcb6e',
  DISABLED_AT_SOURCE: '#e17055',
};

const SOURCE_COLORS = ['#0984e3', '#00b894', '#6c5ce7', '#fdcb6e'];
const STATUS_COLORS = ['#00b894', '#fdcb6e', '#d63031', '#e17055'];

const PERIOD_OPTIONS = [
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: '90d', label: '90 Days' },
  { value: '365d', label: '1 Year' },
];

const RECENT_EVENTS_COLUMNS = [
  { key: 'eventType', label: 'Event', width: '100px' },
  { key: 'userId', label: 'User ID', width: '180px', render: (v) => truncate(v, 24) },
  { key: 'source', label: 'Source', width: '120px' },
  {
    key: 'timestamp',
    label: 'Timestamp (IST)',
    width: '180px',
    render: (v) => formatIST(v),
  },
];

/** Truncate string for display */
const truncate = (str, max) => {
  if (!str) return '-';
  return str.length > max ? str.slice(0, max - 2) + '..' : str;
};

/** Format IST timestamp for display */
const formatIST = (isoStr) => {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  } catch {
    return isoStr;
  }
};

/**
 * Dashboard page component.
 */
const Dashboard = () => {
  const [summary, setSummary] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [distribution, setDistribution] = useState(null);
  const [accountStats, setAccountStats] = useState([]);
  const [period, setPeriod] = useState('30d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryRes, timelineRes, distRes, accountsRes] = await Promise.allSettled([
        getDashboardSummary(),
        getDashboardTimeline(period, 'day'),
        getDashboardDistribution(),
        getAccounts(),
      ]);

      if (summaryRes.status === 'fulfilled') {
        const raw = summaryRes.value;
        setSummary(raw.data || raw);
      }
      if (timelineRes.status === 'fulfilled') {
        const raw = timelineRes.value;
        setTimeline(formatTimelineData(raw.data || raw));
      }
      if (distRes.status === 'fulfilled') {
        const raw = distRes.value;
        setDistribution(raw.data || raw);
      }
      if (accountsRes.status === 'fulfilled') {
        const raw = accountsRes.value;
        const data = raw.data || raw;
        setAccountStats(data.accounts || []);
      }

      const allFailed = [summaryRes, timelineRes, distRes].every((r) => r.status === 'rejected');
      if (allFailed) {
        setError(summaryRes.reason?.message || 'Failed to load dashboard data');
      }
    } catch (err) {
      setError(err.message || 'Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return <div className="dash-loading">Loading dashboard...</div>;
  }

  if (error) {
    return (
      <div className="dash-error">
        <p>Error: {error}</p>
        <button onClick={loadData}>Retry</button>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <h1 className="dash-title">Dashboard</h1>

      {/* Summary cards */}
      <SummaryCards summary={summary} />

      {/* Event timeline chart */}
      <section className="dash-section">
        <div className="dash-section-header">
          <h2 className="dash-section-title">Event Timeline</h2>
          <div className="period-selector">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`period-btn ${period === opt.value ? 'period-btn--active' : ''}`}
                onClick={() => setPeriod(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="chart-container">
          <EventTimelineChart data={timeline} />
        </div>
      </section>

      {/* Distribution charts */}
      <section className="dash-section">
        <h2 className="dash-section-title">User Distribution</h2>
        <div className="charts-row">
          <div className="chart-card">
            <h3 className="chart-card-title">By Identity Source</h3>
            <DistributionPie
              data={formatPieData(distribution?.bySource)}
              colors={SOURCE_COLORS}
            />
          </div>
          <div className="chart-card">
            <h3 className="chart-card-title">By Status</h3>
            <DistributionPie
              data={formatPieData(distribution?.byStatus)}
              colors={STATUS_COLORS}
            />
          </div>
        </div>
      </section>

      {/* Per-Account Breakdown */}
      {accountStats.length > 0 && (
        <section className="dash-section">
          <h2 className="dash-section-title">Per-Account Breakdown</h2>
          <div className="account-breakdown">
            {accountStats.map((acct) => (
              <div key={acct.accountId} className="account-breakdown-card">
                <div className="account-breakdown-name">{acct.accountName || acct.accountId}</div>
                <div className="account-breakdown-id">{acct.accountId}</div>
                <div className="account-breakdown-count">{acct.resourceCount ?? '-'}</div>
                <div className="account-breakdown-label">resources</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent events table */}
      <section className="dash-section">
        <h2 className="dash-section-title">Recent Events</h2>
        <DataTable
          columns={RECENT_EVENTS_COLUMNS}
          data={summary?.recentEvents || []}
          pageSize={10}
          emptyMessage="No recent events"
        />
      </section>
    </div>
  );
};

// Sub-components 

const SummaryCards = ({ summary }) => {
  if (!summary) return null;

  const userCounts = summary.userCounts || {};
  const activity = summary.activitySnapshot || {};
  const byStatus = userCounts.byStatus || {};

  const cards = [
    { label: 'Total Users', value: userCounts.total ?? 0, color: '#0984e3' },
    { label: 'Active', value: byStatus.ACTIVE ?? 0, color: '#00b894' },
    { label: 'Disabled', value: byStatus.DISABLED ?? 0, color: '#fdcb6e' },
    { label: 'Deleted', value: byStatus.DELETED ?? 0, color: '#d63031' },
    { label: 'Inactive', value: byStatus.INACTIVE ?? activity.inactive90Days ?? 0, color: '#e17055' },
    { label: 'Active Today', value: activity.activeToday ?? 0, color: '#6c5ce7' },
  ];

  return (
    <div className="summary-cards">
      {cards.map((card) => (
        <div key={card.label} className="summary-card" style={{ borderTopColor: card.color }}>
          <span className="card-value">{card.value.toLocaleString('en-IN')}</span>
          <span className="card-label">{card.label}</span>
        </div>
      ))}
    </div>
  );
};

const EventTimelineChart = ({ data }) => {
  if (!data || data.length === 0) {
    return <p className="chart-empty">No timeline data available</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f2f6" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip />
        <Legend />
        {Object.keys(EVENT_COLORS).map((eventType) => (
          <Line
            key={eventType}
            type="monotone"
            dataKey={eventType}
            stroke={EVENT_COLORS[eventType]}
            strokeWidth={2}
            dot={false}
            name={eventType}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
};

const DistributionPie = ({ data, colors }) => {
  if (!data || data.length === 0) {
    return <p className="chart-empty">No data</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          outerRadius={80}
          dataKey="value"
          nameKey="name"
          label={({ name, value }) => `${name}: ${value}`}
          labelLine={false}
        >
          {data.map((_, idx) => (
            <Cell key={idx} fill={colors[idx % colors.length]} />
          ))}
        </Pie>
        <Tooltip />
      </PieChart>
    </ResponsiveContainer>
  );
};

// Data formatting helpers 

/**
 * Format timeline API response into chart-friendly data.
 * API returns { buckets: [{ bucket, CREATED, MODIFIED, ... }] }.
 * Chart expects array with `date` key.
 */
const formatTimelineData = (data) => {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (data.buckets) {
    return data.buckets.map((b) => ({ date: b.bucket, ...b }));
  }
  if (data.timeline) return data.timeline;
  return [];
};

/**
 * Format distribution object { KEY: count } into pie chart data.
 */
const formatPieData = (obj) => {
  if (!obj) return [];
  return Object.entries(obj).map(([name, value]) => ({ name, value }));
};

export default Dashboard;
