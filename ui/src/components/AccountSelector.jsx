/**
 * AccountSelector - dropdown to filter by AWS account.
 * Populated from GET /admin/accounts.
 * "All Accounts" is the default option (passes null to onChange).
 * @module components/AccountSelector
 */

import { useState, useEffect } from 'react';
import { getAccounts } from '../utils/api.js';

const AccountSelector = ({ onChange, value }) => {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await getAccounts();
        const data = res.data || res;
        if (!cancelled) {
          setAccounts(data.accounts || []);
        }
      } catch {
        // Silently fail - selector will just show "All Accounts"
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const handleChange = (e) => {
    const val = e.target.value;
    onChange(val || null);
  };

  return (
    <select
      className="account-selector"
      value={value || ''}
      onChange={handleChange}
      disabled={loading}
      style={{
        padding: '8px 12px',
        fontSize: 13,
        border: '1px solid #e2e8f0',
        borderRadius: 6,
        background: '#ffffff',
        color: '#1a202c',
        minWidth: 220,
        cursor: loading ? 'wait' : 'pointer',
      }}
    >
      <option value="">{loading ? 'Loading accounts...' : 'All Accounts'}</option>
      {accounts.map((acct) => (
        <option key={acct.accountId} value={acct.accountId}>
          {acct.accountName} ({acct.accountId})
        </option>
      ))}
    </select>
  );
};

export default AccountSelector;
