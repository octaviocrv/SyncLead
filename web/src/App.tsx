import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Leads from './pages/Leads';
import Pending from './pages/Pending';
import Routing from './pages/Routing';
import Stores from './pages/Stores';
import Integrations from './pages/Integrations';
import Health from './pages/Health';
import Metrics from './pages/Metrics';
import { AuthProvider, useAuth } from './auth';
import { LeadsProvider } from './leads';

function Protected({ children, adminOnly = false }: { children: JSX.Element; adminOnly?: boolean }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="empty">Carregando…</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== 'admin') return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <Protected>
            <LeadsProvider>
              <Layout />
            </LeadsProvider>
          </Protected>
        }
      >
        <Route index element={<Overview />} />
        <Route path="leads" element={<Leads />} />
        <Route path="pendencias" element={<Pending />} />
        <Route path="metricas" element={<Metrics />} />
        <Route path="saude" element={<Health />} />
        <Route path="roteamento" element={<Protected adminOnly><Routing /></Protected>} />
        <Route path="lojas" element={<Protected adminOnly><Stores /></Protected>} />
        <Route path="integracoes" element={<Protected adminOnly><Integrations /></Protected>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </AuthProvider>
  );
}
