import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { ToastProvider } from './components/ui';
import Layout from './components/Layout';
import LoginPage from './pages/Login';
import TelegramCallbackPage from './pages/TelegramCallback';
import DashboardPage from './pages/Dashboard';
import EntriesPage from './pages/Entries';
import TasksPage from './pages/Tasks';
import ReportsPage from './pages/Reports';
import PendingPage from './pages/Pending';
import { ClientsPage, ProjectsPage } from './pages/Catalog';
import UsersPage from './pages/Users';
import RolesPage from './pages/Roles';
import SettingsPage from './pages/Settings';
import ProfilePage from './pages/Profile';
import TelegramLinkPage from './pages/TelegramLink';

/** Guard de sesión: si no hay usuario, redirige al login. */
function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="login-wrap">
        <span className="muted">Cargando sesión…</span>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

/** Guard de permisos: muestra un mensaje si el rol no alcanza. */
function RequirePermission({ permission, children }: { permission: string; children: JSX.Element }) {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <div className="card">
        <h3>Acceso restringido</h3>
        <p className="muted small" style={{ marginTop: 8 }}>
          Tu rol no tiene el permiso <span className="mono">{permission}</span>. Solicítalo a un administrador.
        </p>
      </div>
    );
  }
  return children;
}

/** Rutas del panel. */
function AppRoutes() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      {/* Callback del Telegram OAuth: Telegram devuelve aquí el hash firmado. */}
      <Route path="/login/telegram/callback" element={<TelegramCallbackPage />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Layout>
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/registros" element={<EntriesPage />} />
                <Route
                  path="/tareas"
                  element={
                    <RequirePermission permission="entries:read:own">
                      <TasksPage />
                    </RequirePermission>
                  }
                />
                <Route path="/reportes" element={<ReportsPage />} />
                <Route path="/pendientes" element={<PendingPage />} />
                <Route
                  path="/clientes"
                  element={
                    <RequirePermission permission="clients:read">
                      <ClientsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/proyectos"
                  element={
                    <RequirePermission permission="projects:read">
                      <ProjectsPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/usuarios"
                  element={
                    <RequirePermission permission="users:read">
                      <UsersPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/roles"
                  element={
                    <RequirePermission permission="roles:read">
                      <RolesPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/configuracion"
                  element={
                    <RequirePermission permission="settings:read">
                      <SettingsPage />
                    </RequirePermission>
                  }
                />
                <Route path="/perfil" element={<ProfilePage />} />
                <Route path="/telegram" element={<TelegramLinkPage />} />
                <Route
                  path="*"
                  element={
                    <div className="card">
                      <h3>Página no encontrada</h3>
                      <p className="muted small" style={{ marginTop: 8 }}>
                        Revisa la dirección o vuelve al dashboard.
                      </p>
                    </div>
                  }
                />
              </Routes>
            </Layout>
          </RequireAuth>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
