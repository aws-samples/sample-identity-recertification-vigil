/**
 * Protected route wrapper - redirects unauthenticated users to login.
 * @module components/ProtectedRoute
 */

import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider.jsx';

/**
 * ProtectedRoute component.
 * Shows a loading spinner while auth state resolves,
 * redirects to /login if not authenticated.
 * @param {{ children: React.ReactNode }} props
 */
const ProtectedRoute = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <p>Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children;
};

export default ProtectedRoute;
