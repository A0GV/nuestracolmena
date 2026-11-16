import { Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuth } from './lib/auth';
import AppShell from './layouts/AppShell';
import LoginPage from './pages/LoginPage';
import { ChunkErrorBoundary, lazyRoute } from './lib/lazyRoute';

const CasesPage = lazyRoute(() => import('./pages/CasesPage'));
const CaseDetailPage = lazyRoute(() => import('./pages/CaseDetailPage'));
const AlertsPage = lazyRoute(() => import('./pages/AlertsPage'));
const TasksPage = lazyRoute(() => import('./pages/TasksPage'));
const DashboardsPage = lazyRoute(() => import('./pages/DashboardsPage'));
const DashboardViewPage = lazyRoute(() => import('./pages/DashboardViewPage'));
const KnowledgeBasePage = lazyRoute(() => import('./pages/KnowledgeBasePage'));
const SearchPage = lazyRoute(() => import('./pages/SearchPage'));
const AdminPage = lazyRoute(() => import('./pages/AdminPage'));
const SettingsPage = lazyRoute(() => import('./pages/SettingsPage'));

function RouteFallback() {
  return (
    <div style={{ minHeight: '50vh', display: 'grid', placeItems: 'center' }}>
      <Spin size="large" />
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!user && location.pathname !== '/login') {
    return <Navigate to="/login" replace />;
  }

  return (
    <ChunkErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/*"
            element={
              <AppShell>
                <Routes>
                  <Route path="/" element={<Navigate to="/cases" replace />} />
                  <Route path="/cases" element={<CasesPage />} />
                  <Route path="/cases/:idOrNumber" element={<CaseDetailPage />} />
                  <Route path="/cases/:idOrNumber/:tab" element={<CaseDetailPage />} />
                  <Route path="/alerts" element={<AlertsPage />} />
                  <Route path="/global-tasks" element={<TasksPage />} />
                  <Route path="/tasks" element={<Navigate to="/global-tasks" replace />} />
                  <Route path="/dashboards" element={<DashboardsPage />} />
                  <Route path="/dashboards/:id" element={<DashboardViewPage />} />
                  <Route path="/knowledge-base" element={<KnowledgeBasePage />} />
                  <Route path="/search" element={<SearchPage />} />
                  <Route path="/admin" element={<AdminPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/cases" replace />} />
                </Routes>
              </AppShell>
            }
          />
        </Routes>
      </Suspense>
    </ChunkErrorBoundary>
  );
}
