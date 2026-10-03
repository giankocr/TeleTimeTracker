import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { formatSeconds } from '../lib/format';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  permission?: string;
}

const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: 'Operación',
    items: [
      { to: '/', label: 'Dashboard', icon: '📊' },
      { to: '/registros', label: 'Registros', icon: '⏱', permission: 'entries:read:own' },
      { to: '/reportes', label: 'Reportes', icon: '📈', permission: 'reports:own' },
      { to: '/pendientes', label: 'Mis pendientes', icon: '📝' },
    ],
  },
  {
    section: 'Catálogo',
    items: [
      { to: '/clientes', label: 'Clientes', icon: '🏢', permission: 'clients:read' },
      { to: '/proyectos', label: 'Proyectos', icon: '📁', permission: 'projects:read' },
    ],
  },
  {
    section: 'Administración',
    items: [
      { to: '/usuarios', label: 'Usuarios', icon: '👥', permission: 'users:read' },
      { to: '/roles', label: 'Roles y permisos', icon: '🛡', permission: 'roles:read' },
      { to: '/configuracion', label: 'Configuración', icon: '⚙️', permission: 'settings:read' },
    ],
  },
  {
    section: 'Mi cuenta',
    items: [
      { to: '/perfil', label: 'Mi perfil', icon: '🙋' },
      { to: '/telegram', label: 'Vincular Telegram', icon: '🤖' },
    ],
  },
];

/** Cronometro en vivo del usuario autenticado (se actualiza cada segundo). */
function ActiveTimer() {
  const [entry, setEntry] = useState<any | null>(null);
  const [tick, setTick] = useState(0);

  const load = async () => {
    try {
      const data = await api.get<{ entry: any }>('/entries/active');
      setEntry(data.entry);
    } catch {
      setEntry(null);
    }
  };

  useEffect(() => {
    void load();
    const poll = setInterval(load, 30_000);
    const clock = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, []);

  useEffect(() => {
    // El cronometro necesita recalcularse cuando cambia el registro.
    setTick((t) => t + 1);
  }, [entry?.id]);

  const navigate = useNavigate();
  if (!entry) return null;

  const elapsed = entry.liveSeconds + (entry.status === 'RUNNING' ? tick % 100000 : 0);
  return (
    <button
      className="btn btn-sm"
      onClick={() => navigate('/registros')}
      title={`${entry.title ?? 'Tarea'} · ${entry.projectName ?? 'sin proyecto'}`}
    >
      <span className={`pill-dot ${entry.status === 'RUNNING' ? 'pulse' : ''}`} style={{ color: entry.status === 'RUNNING' ? '#22c55e' : '#f59e0b' }} />
      <span className="mono">{entry.status === 'PAUSED' ? '⏸ ' : ''}{formatSeconds(Math.max(0, elapsed))}</span>
      <span className="nowrap" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {entry.title ?? 'Tarea'}
      </span>
    </button>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout, can } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  const title =
    NAV.flatMap((s) => s.items).find((i) => i.to === location.pathname)?.label ??
    (location.pathname.startsWith('/registros') ? 'Registros' : 'Panel');

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-logo">⏱</div>
          <div>
            <div className="brand-name">TeleTimeTracker</div>
            <div className="brand-sub">Control de tiempo</div>
          </div>
        </div>

        {NAV.map((section) => {
          const items = section.items.filter((i) => !i.permission || can(i.permission));
          if (!items.length) return null;
          return (
            <div key={section.section}>
              <div className="nav-section">{section.section}</div>
              {items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                  end={item.to === '/'}
                >
                  <span className="nav-icon">{item.icon}</span>
                  {item.label}
                </NavLink>
              ))}
            </div>
          );
        })}

        <div style={{ flex: 1 }} />
        <div className="divider" />
        <div className="stack-sm" style={{ padding: '6px 8px' }}>
          <div className="small" style={{ fontWeight: 600 }}>{user?.fullName}</div>
          <div className="tiny muted-2">{user?.role?.name ?? user?.role?.key}</div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void logout()}
            style={{ justifyContent: 'flex-start' }}
          >
            ⏏ Cerrar sesión
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="btn btn-ghost btn-sm menu-toggle" onClick={() => setMenuOpen((v) => !v)} aria-label="Menú">
            ☰
          </button>
          <span className="topbar-title">{title}</span>
          <div className="spacer" />
          <ActiveTimer />
          <span className="badge badge-primary nowrap">{user?.role?.key}</span>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
