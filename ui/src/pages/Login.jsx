/**
 * Login page - Cognito sign-in form.
 * Redirects to dashboard after successful authentication.
 * @module pages/Login
 */

import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../components/AuthProvider.jsx';
import './Login.css';

/**
 * Login page component.
 */
const Login = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { handleSignIn, isAuthenticated } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Redirect if already authenticated
  if (isAuthenticated) {
    const from = location.state?.from?.pathname || '/';
    navigate(from, { replace: true });
    return null;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username || !password) {
      setError('Email and password are required');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await handleSignIn(username, password);
      const from = location.state?.from?.pathname || '/';
      navigate(from, { replace: true });
    } catch (err) {
      setError(err.message || 'Sign in failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <h1 className="login-title">Identity Governance</h1>
          <p className="login-subtitle">Audit Dashboard - Sign In</p>
        </div>
        <form className="login-form" onSubmit={handleSubmit}>
          {error && <div className="login-error">{error}</div>}
          <div className="form-field">
            <label htmlFor="username" className="form-label">Email</label>
            <input
              id="username"
              type="email"
              className="form-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="auditor@example.com"
              autoComplete="username"
              disabled={loading}
            />
          </div>
          <div className="form-field">
            <label htmlFor="password" className="form-label">Password</label>
            <input
              id="password"
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="********"
              autoComplete="current-password"
              disabled={loading}
            />
          </div>
          <button
            type="submit"
            className="login-btn"
            disabled={loading}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;
