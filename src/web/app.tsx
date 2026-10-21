import type * as preact from 'preact';
import { LocationProvider, Route, Router, useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';
import { AUTH_EXPIRED } from './api';
import { Layout } from './components/Layout';
import { t, useLang } from './i18n';
import { Branch } from './pages/Branch';
import { Home, MonthRedirect } from './pages/Home';
import { Login, safeNext } from './pages/Login';
import { Distribute } from './pages/Distribute';
import { Departments } from './pages/admin/Departments';
import { Hierarchy } from './pages/admin/Hierarchy';
import { Packs } from './pages/admin/Packs';
import { Settings } from './pages/admin/Settings';
import { Users } from './pages/admin/Users';
import { Admin, NotAllowed, NotFound } from './pages/Placeholders';
import { expire, loadSession, useSession } from './session';

/** The setup screens are for administrators only (the API enforces it too). */
function adminOnly(Page: () => preact.JSX.Element): () => preact.JSX.Element {
  return function AdminPage() {
    const { user } = useSession();
    return user?.role === 'admin' ? <Page /> : <NotAllowed />;
  };
}
const AdminUsers = adminOnly(Users);
const AdminDepartments = adminOnly(Departments);
const AdminPacks = adminOnly(Packs);
const AdminSettings = adminOnly(Settings);
const AdminHierarchy = adminOnly(Hierarchy);

function Routes() {
  useLang();
  const { path, url, query, route } = useLocation();
  const { status } = useSession();

  useEffect(() => {
    void loadSession().catch(() => undefined);
  }, []);

  // Any 401 forgets the user; the effect below then sends us to /login.
  useEffect(() => {
    window.addEventListener(AUTH_EXPIRED, expire);
    return () => window.removeEventListener(AUTH_EXPIRED, expire);
  }, []);

  useEffect(() => {
    if (status === 'out' && path !== '/login') {
      route(`/login?next=${encodeURIComponent(url)}`, true);
    } else if (status === 'in' && path === '/login') {
      route(safeNext(query.next), true);
    }
  }, [status, path]);

  if (status === 'loading') return <p class="boot muted">{t('loading')}</p>;
  if (status === 'out') return path === '/login' ? <Login /> : null;

  return (
    <Layout>
      <Router>
        <Route path="/" component={Home} />
        <Route path="/m/:mid" component={MonthRedirect} />
        <Route path="/m/:mid/n/:nid" component={Distribute} />
        <Route path="/m/:mid/n/:nid/branch" component={Branch} />
        <Route path="/admin/users" component={AdminUsers} />
        <Route path="/admin/departments" component={AdminDepartments} />
        <Route path="/admin/packs" component={AdminPacks} />
        <Route path="/admin/settings" component={AdminSettings} />
        <Route path="/admin/hierarchy" component={AdminHierarchy} />
        <Route path="/admin" component={Admin} />
        <Route path="/admin/*" component={Admin} />
        <Route default component={NotFound} />
      </Router>
    </Layout>
  );
}

export function App() {
  return (
    <LocationProvider>
      <Routes />
    </LocationProvider>
  );
}
