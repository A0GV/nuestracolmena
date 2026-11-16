import { useCallback, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AlertOutlined,
  AppstoreOutlined,
  BellOutlined,
  BookOutlined,
  CheckSquareOutlined,
  DashboardOutlined,
  FolderOpenOutlined,
  LineChartOutlined,
  LogoutOutlined,
  PlusOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Dropdown, Input, Select, Space, Tooltip, Typography } from 'antd';
import { useAuth } from '../lib/auth';
import { useLiveUpdates } from '../lib/live';

const rail = [
  { key: 'cases', path: '/cases', icon: <FolderOpenOutlined />, label: 'Casos' },
  { key: 'alerts', path: '/alerts', icon: <BellOutlined />, label: 'Alertas' },
  { key: 'tasks', path: '/global-tasks', icon: <CheckSquareOutlined />, label: 'Tareas' },
  { key: 'knowledge', path: '/knowledge-base', icon: <BookOutlined />, label: 'Knowledge base' },
  { key: 'dashboards', path: '/dashboards', icon: <DashboardOutlined />, label: 'Dashboards' },
  { key: 'search', path: '/search', icon: <SearchOutlined />, label: 'Búsqueda' },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const { user, logout, switchOrganisation, can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  // Alertas y casos al instante: la API avisa por /stream cuando algo cambia.
  const openAlerts = useCallback(() => navigate('/alerts'), [navigate]);
  useLiveUpdates(user ? `${user.id}:${user.activeOrganisation ?? ''}` : null, openAlerts);

  const active = useMemo(() => {
    if (location.pathname.startsWith('/cases')) return 'cases';
    if (location.pathname.startsWith('/alerts')) return 'alerts';
    if (location.pathname.startsWith('/global-tasks')) return 'tasks';
    if (location.pathname.startsWith('/knowledge-base')) return 'knowledge';
    if (location.pathname.startsWith('/dashboards')) return 'dashboards';
    if (location.pathname.startsWith('/search')) return 'search';
    if (location.pathname.startsWith('/admin')) return 'admin';
    return '';
  }, [location.pathname]);

  const crumbs = location.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));

  const isAdmin =
    can('managePlatform') || can('manageOrganisation') || can('manageProfile') ||
    can('manageUser') || can('manageUser/org') || can('manageConfig');

  return (
    <div className="myhive-shell">
      <div className="trial-strip">
        Nuestracolmena {user?.activeOrganisation ? `· ${user.activeOrganisation}` : ''} · comunidad
      </div>
      <header className="myhive-topbar">
        <Link to="/cases" className="myhive-logo">Nuestra<span>colmena</span></Link>
        <div className="myhive-crumbs">
          {crumbs.length ? crumbs.join(' / ') : 'Casos'}
        </div>
        <Input.Search
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={(value) => value && navigate(`/search?q=${encodeURIComponent(value)}`)}
          placeholder={`Buscar en ${user?.activeOrganisation || 'la organización'}`}
          style={{ maxWidth: 420 }}
          allowClear
        />
        <div className="myhive-top-actions">
          {can('manageCase/create') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/cases?create=1')}>
              Crear caso
            </Button>
          )}
          <Select
            value={user?.activeOrganisation}
            style={{ width: 130 }}
            options={(user?.organisations || []).map((o) => ({ value: o.name, label: o.name }))}
            onChange={(value) => switchOrganisation(value)}
          />
          <Dropdown
            menu={{
              items: [
                { key: 'settings', icon: <SettingOutlined />, label: 'Ajustes', onClick: () => navigate('/settings') },
                { key: 'logout', icon: <LogoutOutlined />, label: 'Cerrar sesión', onClick: logout },
              ],
            }}
          >
            <Space style={{ cursor: 'pointer', color: '#fff' }}>
              <Avatar size="small" style={{ background: '#54c1c2' }}>{(user?.name || 'U').slice(0, 1)}</Avatar>
              <Typography.Text style={{ color: 'rgba(255,255,255,.85)' }}>{user?.name}</Typography.Text>
            </Space>
          </Dropdown>
        </div>
      </header>
      <div className="myhive-body">
        <nav className="myhive-rail">
          {rail.map((item) => (
            <Tooltip key={item.key} title={item.label} placement="right">
              <button
                className={active === item.key ? 'active' : ''}
                onClick={() => navigate(item.path)}
              >
                {item.icon}
              </button>
            </Tooltip>
          ))}
          <Tooltip title="Gráficas (Grafana)" placement="right">
            <button onClick={() => window.open('/grafana/', '_blank', 'noopener')}>
              <LineChartOutlined />
            </button>
          </Tooltip>
          {isAdmin && (
            <Tooltip title="Administración" placement="right">
              <button className={active === 'admin' ? 'active' : ''} onClick={() => navigate('/admin')}>
                <AppstoreOutlined />
              </button>
            </Tooltip>
          )}
          <div style={{ flex: 1 }} />
          <Tooltip title="Organización" placement="right">
            <button onClick={() => navigate('/admin?tab=users')}>
              <TeamOutlined />
            </button>
          </Tooltip>
          <Tooltip title="Mi cuenta" placement="right">
            <button onClick={() => navigate('/settings')}>
              <UserOutlined />
            </button>
          </Tooltip>
        </nav>
        <main className="myhive-content">{children}</main>
      </div>
    </div>
  );
}
