/**
 * Reusable sortable/paginated data table.
 * Professional, data-dense design for compliance auditors.
 * @module components/DataTable
 */

import { useState, useMemo } from 'react';
import './DataTable.css';

/**
 * @typedef {object} Column
 * @property {string} key - Data field key
 * @property {string} label - Column header label
 * @property {boolean} [sortable=true] - Whether column is sortable
 * @property {Function} [render] - Custom render function (value, row) => ReactNode
 * @property {string} [width] - CSS width
 */

/**
 * DataTable component.
 * @param {object} props
 * @param {Column[]} props.columns - Column definitions
 * @param {object[]} props.data - Row data
 * @param {number} [props.pageSize=10] - Rows per page
 * @param {Function} [props.onRowClick] - Row click handler (row) => void
 * @param {boolean} [props.loading=false] - Show loading state
 * @param {string} [props.emptyMessage='No data available'] - Empty state message
 */
const DataTable = ({
  columns,
  data,
  pageSize = 10,
  onRowClick,
  loading = false,
  emptyMessage = 'No data available',
}) => {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [currentPage, setCurrentPage] = useState(0);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setCurrentPage(0);
  };

  const sortedData = useMemo(() => {
    if (!sortKey) return data;
    return [...data].sort((a, b) => {
      const aVal = a[sortKey] ?? '';
      const bVal = b[sortKey] ?? '';
      const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedData.length / pageSize));
  const pageData = sortedData.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize
  );

  if (loading) {
    return <div className="dt-loading">Loading...</div>;
  }

  return (
    <div className="dt-wrapper">
      <div className="dt-scroll">
        <table className="dt-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`dt-th ${col.sortable !== false ? 'dt-th--sortable' : ''}`}
                  style={col.width ? { width: col.width } : undefined}
                  onClick={() => col.sortable !== false && handleSort(col.key)}
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span className="dt-sort-icon">
                      {sortDir === 'asc' ? ' ^' : ' v'}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageData.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="dt-empty">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              pageData.map((row, idx) => (
                <tr
                  key={row.id || row.userId || idx}
                  className={`dt-row ${onRowClick ? 'dt-row--clickable' : ''}`}
                  onClick={() => onRowClick?.(row)}
                >
                  {columns.map((col) => (
                    <td key={col.key} className="dt-td">
                      {col.render
                        ? col.render(row[col.key], row)
                        : (row[col.key] ?? '-')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {sortedData.length > pageSize && (
        <div className="dt-pagination">
          <button
            className="dt-page-btn"
            disabled={currentPage === 0}
            onClick={() => setCurrentPage((p) => p - 1)}
          >
            Prev
          </button>
          <span className="dt-page-info">
            Page {currentPage + 1} of {totalPages}
            {' '}({sortedData.length} records)
          </span>
          <button
            className="dt-page-btn"
            disabled={currentPage >= totalPages - 1}
            onClick={() => setCurrentPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
};

export default DataTable;
