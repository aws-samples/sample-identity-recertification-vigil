/**
 * App root - React Router configuration with protected routes.
 * Uses Cognito authentication via AuthProvider.
 * @module App
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './components/AuthProvider.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import UserSearch from './pages/UserSearch.jsx';
import UserDetail from './pages/UserDetail.jsx';
import RecertificationReview from './pages/RecertificationReview.jsx';
import AdminConsole from './pages/AdminConsole.jsx';
import ActivityReport from './pages/ActivityReport.jsx';
import './App.css';

/**
 * App component - top-level routing and auth.
 */
const App = () => {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public route */}
          <Route path="/login" element={<Login />} />

          {/* Protected routes with layout */}
          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="search" element={<UserSearch />} />
            <Route path="users/:userId" element={<UserDetail />} />
            <Route path="recert/:cycleId" element={<RecertificationReview />} />
            <Route path="admin" element={<AdminConsole />} />
            <Route path="activity" element={<ActivityReport />} />
          </Route>

          {/* Catch-all - redirect to dashboard */}
          <Route path="*" element={<Login />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
};

export default App;
