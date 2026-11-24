import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutGrid,
  Users,
  AlertTriangle,
  Route as RouteIcon,
  Store,
  Plug,
  Search,
  LogOut,
  Workflow,
  HeartPulse,
  BarChart3,
} from 'lucide-react';
import { roleLabel, useAuth } from '../auth';
import { isPending, useLeads } from '../leads';
import StorageBanner from './StorageBanner';

const sections = (pendingCount: number, isAdmin: boolean) => [
  {
    title: 'Operação',
    items: [
      { to: '/', label: 'Visão Geral', icon: LayoutGrid, end: true },
      { to: '/leads', label: 'Leads', icon: Users },
      { to: '/pendencias', label: 'Pendências', icon: AlertTriangle, badge: pendingCount },
      { to: '/metricas', label: 'Métricas', icon: BarChart3 },
      { to: '/saude', label: 'Saúde', icon: HeartPulse },
    ],
  },
  ...(!isAdmin ? [] : [{
    title: 'Configuração',
    items: [
      { to: '/roteamento', label: 'Regras de Roteamento', icon: RouteIcon },
      { to: '/lojas', label: 'Lojas', icon: Store },
      { to: '/integracoes', label: 'Integrações', icon: Plug },
    ],
  }]),
];

export default function Layout() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const name = user?.name ?? '';
  const { leads, error, updatedAt } = useLeads();
  const pendingCount = leads.filter(isPending).length;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Workflow size={16} /></span>
          SyncLead
        </div>

        <nav>
          {sections(pendingCount, user?.role === 'admin').map((section) => (
            <div key={section.title} className="nav-section">
              <div className="nav-title">{section.title}</div>
              {section.items.map(({ to, label, icon: Icon, end, badge }) => (
                <NavLink key={to} to={to} end={end} className="nav-item" title={label}>
                  <Icon size={16} />
                  <span>{label}</span>
                  {badge ? <span className="nav-badge">{badge}</span> : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-user">
          <span className="avatar">{name.slice(0, 2).toUpperCase()}</span>
          <div className="user-info">
            <strong title={user?.email}>{name}</strong>
            <small>{user ? roleLabel(user.role) : ''}</small>
          </div>
          <button
            className="icon-button"
            title="Sair"
            onClick={() => {
              void logout().then(() => navigate('/login'));
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      <div className="main">
        <StorageBanner />
        <header className="topbar">
          <label className="search">
            <Search size={15} />
            <input
              placeholder="Buscar lead pelo ID (leadgen_id)"
              onKeyDown={(e) => {
                const value = e.currentTarget.value.trim();
                if (e.key === 'Enter') navigate(value ? `/leads?q=${encodeURIComponent(value)}` : '/leads');
              }}
            />
          </label>
          {error ? (
            <span className="env-tag env-error" title={error}>API indisponível: {error}</span>
          ) : (
            <span className="env-tag env-live">
              Dados reais{updatedAt ? ` · atualizado ${updatedAt.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : ' · carregando…'}
            </span>
          )}
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
