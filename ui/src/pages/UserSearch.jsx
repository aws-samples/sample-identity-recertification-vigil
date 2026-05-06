/**
 * User Search page - search bar with debounced input, filter dropdowns,
 * results table with click-through to User Detail.
 * @module pages/UserSearch
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import { searchUsers } from '../utils/api.js';
import './UserSearch.css';

const IDENTITY_SOURCES = ['', 'COGNITO', 'JIT', 'IAM', 'IDENTITY_CENTER', 'SCIM'];
const STATUS_OPTIONS = ['', 'ACTIVE', 'DISABLED', 'DELETED', 'ORPHANED'];
const DEBOUNCE_MS = 400;

const COLUMNS = [
  { key: 'userName', label: 'Name', width: '160px' },
  { key: 'email', label: 'Email', width: '200px' },
  { key: 'identitySource', label: 'Source', width: '120px', render: (v) => renderBadge(v, 'source') },
  { key: 'status', label: 'Status', width: '100px', render: (v) => renderBadge(v, 'status') },
  {
    key: 'lastActiveAt',
    label: 'Last Active',
    width: '160px',
    render: (v) => formatIST(v),
  },
  {
    key: 'lastRecertDecision',
    label: 'Last Recert',
    width: '120px',
    render: (v) => v || '-',
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

/** Render a colored badge */
const renderBadge = (value, type) => {
  if (!value) return '-';
  const classMap = {
    source: {
      COGNITO: 'badge--blue',
      JIT: 'badge--purple',
      IAM: 'badge--teal',
      IDENTITY_CENTER: 'badge--orange',
      SCIM: 'badge--orange',
    },
    status: {
      ACTIVE: 'badge--green',
      DISABLED: 'badge--yellow',
      DELETED: 'badge--red',
      ORPHANED: 'badge--orange',
    },
  };
  const cls = classMap[type]?.[value] || '';
  return <span className={`badge ${cls}`}>{value}</span>;
};

/**
 * UserSearch page component.
 */
const UserSearch = () => {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef(null);

  const executeSearch = useCallback(async (searchQuery, sourceFilter, statusFilter) => {
    if (!searchQuery || searchQuery.trim().length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }

    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const data = await searchUsers(searchQuery.trim(), {
        source: sourceFilter || undefined,
        status: statusFilter || undefined,
        limit: 50,
      });
      setResults(data.results || data.data?.results || []);
    } catch (err) {
      setError(err.message || 'Search failed');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced search on query/filter change
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      executeSearch(query, source, status);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query, source, status, executeSearch]);

  const handleRowClick = (row) => {
    if (row.userId) {
      navigate(`/users/${row.userId}`);
    }
  };

  return (
    <div className="user-search">
      <h1 className="search-title">User Search</h1>

      {/* Search controls */}
      <div className="search-controls">
        <div className="search-bar">
          <input
            type="text"
            className="search-input"
            placeholder="Search by email, name, or user ID..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <div className="search-filters">
          <label className="filter-label">
            Source:
            <select
              className="filter-select"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              {IDENTITY_SOURCES.map((s) => (
                <option key={s} value={s}>{s || 'All Sources'}</option>
              ))}
            </select>
          </label>
          <label className="filter-label">
            Status:
            <select
              className="filter-select"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s || 'All Statuses'}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Error */}
      {error && <div className="search-error">Error: {error}</div>}

      {/* Results */}
      {searched && (
        <div className="search-results">
          <DataTable
            columns={COLUMNS}
            data={results}
            pageSize={15}
            onRowClick={handleRowClick}
            loading={loading}
            emptyMessage="No users found matching your search"
          />
        </div>
      )}

      {!searched && !loading && (
        <div className="search-hint">
          Enter at least 2 characters to search across all identity sources.
        </div>
      )}
    </div>
  );
};

export default UserSearch;
