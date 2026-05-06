/**
 * Application layout - navigation sidebar + header + content area.
 * Professional, data-dense layout for compliance auditors and IT governance admins.
 * Recertification link always visible; page content depends on whether user is an approver.
 * @module components/Layout
 */

import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider.jsx';
import './Layout.css';

/**
 * Compute the current fiscal quarter cycle ID (e.g. "2026-Q2").
 * @returns {string}
 */
const getCurrentCycleId = () => {
  const now = new Date();
  const q = Math.ceil((now.getMonth() + 1) / 3);
  return `${now.getFullYear()}-Q${q}`;
};

/**
 * Layout component with sidebar navigation and header.
 */
const Layout = () => {
  const { user, handleSignOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const isRecertActive = location.pathname.startsWith('/recert');

  const NAV_ITEMS = [
    { path: '/', label: 'Dashboard', icon: '📊' },
    { path: '/search', label: 'User Search', icon: '🔍' },
    { path: '/admin', label: 'Admin Console', icon: '⚙️' },
  ];

  const handleRecertClick = (e) => {
    e.preventDefault();
    navigate(`/recert/${getCurrentCycleId()}`);
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2 className="sidebar-title">VIGIL</h2>
          <span className="sidebar-subtitle">Identity Governance & Intelligence</span>
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              className={({ isActive }) =>
                `nav-link ${isActive ? 'nav-link--active' : ''}`
              }
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
          {/* Recertification - always visible, navigates to current quarter */}
          <a
            href={`/recert/${getCurrentCycleId()}`}
            onClick={handleRecertClick}
            className={`nav-link ${isRecertActive ? 'nav-link--active' : ''}`}
          >
            <span className="nav-icon">✅</span>
            <span className="nav-label">Recertification</span>
          </a>
          {/* Activity Report - last (not yet implemented) */}
          <NavLink
            to="/activity"
            className={({ isActive }) => `nav-link ${isActive ? 'nav-link--active' : ''}`}
          >
            <span className="nav-icon">📈</span>
            <span className="nav-label">Activity Report</span>
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <div className="user-info">
            <span className="user-name">{user?.email || user?.username || 'User'}</span>
            <span className="user-groups">
              {(user?.groups || []).join(', ') || 'No groups'}
            </span>
          </div>
          <button className="sign-out-btn" onClick={handleSignOut}>
            Sign Out
          </button>
        </div>
      </aside>
      <main className="main-content">
        <header className="top-header">
          <div className="header-breadcrumb">
          </div>
          <div className="header-meta">
            IST (UTC+5:30)
          </div>
        </header>
        <div className="content-area">
          <Outlet />
        </div>
      </main>
    </div>
  );
};

export default Layout;
