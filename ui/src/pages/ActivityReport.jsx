/**
 * Activity Report page - stub for Phase 2.
 * Activity tracking is deferred; this page shows a placeholder.
 * @module pages/ActivityReport
 */

import './ActivityReport.css';

const ActivityReport = () => (
  <div className="activity-report">
    <div className="activity-header">
      <h1 className="activity-title">Activity Report</h1>
      <p className="activity-subtitle">Login trends, inactive users, and failed login alerts</p>
    </div>
    <div className="activity-placeholder">
      <div className="activity-placeholder-icon">📈</div>
      <p className="activity-placeholder-text">Activity reporting is coming in Phase 2</p>
      <p className="activity-placeholder-sub">
        This page will show login trends, daily/weekly/monthly stats,
        inactive users (90+ days), and failed login alerts.
      </p>
    </div>
  </div>
);

export default ActivityReport;
