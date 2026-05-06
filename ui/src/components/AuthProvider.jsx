/**
 * Cognito authentication context provider.
 * Wraps the app with auth state and sign-in/sign-out methods.
 * Uses @aws-amplify/auth v6.
 * @module components/AuthProvider
 */

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Amplify } from 'aws-amplify';
import {
  signIn,
  signOut,
  getCurrentUser,
  fetchAuthSession,
} from '@aws-amplify/auth';
import amplifyConfig from '../config/amplify.js';

Amplify.configure(amplifyConfig);

const AuthContext = createContext(null);

/**
 * @typedef {object} AuthState
 * @property {object|null} user - Current authenticated user
 * @property {boolean} isAuthenticated - Whether user is signed in
 * @property {boolean} isLoading - Whether auth state is being resolved
 * @property {string|null} error - Last auth error message
 * @property {Function} handleSignIn - Sign in with email/password
 * @property {Function} handleSignOut - Sign out current user
 */

/**
 * AuthProvider component - manages Cognito auth state.
 * @param {{ children: React.ReactNode }} props
 */
export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const checkAuth = useCallback(async () => {
    try {
      const currentUser = await getCurrentUser();
      const session = await fetchAuthSession();
      const payload = session.tokens?.idToken?.payload || {};
      const groups = payload['cognito:groups'] || [];
      const email = payload.email || null;
      setUser({
        userId: currentUser.userId,
        username: currentUser.username,
        email,
        groups,
      });
      setError(null);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const handleSignIn = useCallback(async (username, password) => {
    setError(null);
    setIsLoading(true);
    try {
      await signIn({ username, password });
      await checkAuth();
    } catch (err) {
      setError(err.message || 'Sign in failed');
      setIsLoading(false);
      throw err;
    }
  }, [checkAuth]);

  const handleSignOut = useCallback(async () => {
    try {
      await signOut();
      setUser(null);
    } catch (err) {
      setError(err.message || 'Sign out failed');
    }
  }, []);

  const value = {
    user,
    isAuthenticated: !!user,
    isLoading,
    error,
    handleSignIn,
    handleSignOut,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

/**
 * Hook to access auth context.
 * @returns {AuthState}
 */
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export default AuthProvider;
