import type * as preact from 'preact';
import { SaveToast } from './components/SaveToast';
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
import { History } from './pages/admin/History';
import { MonthDetail } from './pages/admin/MonthDetail';
import { Months } from './pages/admin/Months';
import { Packs } from './pages/admin/Packs';
import { Settings } from './pages/admin/Settings';
import { Users } from './pages/admin/Users';
import { Admin, NotAllowed, NotFound } from './pages/Placeholders';
import { AdminCycle } from './pages/cycle/AdminCycle';
import { Approve } from './pages/cycle/Approve';
import { CdPage } from './pages/cycle/CdPage';
import { ChangePassword } from './pages/cycle/ChangePassword';
import { CycleSetup } from './pages/cycle/CycleSetup';
import { Reports } from './pages/cycle/Reports';
import { expire, loadSession, useSession } from './session';

/** The setup screens are for administrators only (the API enforces it too). */
function adminOnly<P extends object>(Page: (props: P) => preact.JSX.Element): (props: P) => preact.JSX.Element {
  return function AdminPage(props: P) {
    const { user } = useSession();
    return user?.role === 'admin' ? <Page {...props} /> : <NotAllowed />;
  };
}
const AdminUsers = adminOnly(Users);
const AdminDepartments = adminOnly(Departments);
const AdminPacks = adminOnly(Packs);
const AdminSettings = adminOnly(Settings);
const AdminHierarchy = adminOnly(Hierarchy);
const AdminMonths = adminOnly(Months);
const AdminMonthDetail = adminOnly(MonthDetail);
const AdminHistory = adminOnly(History);
const AdminCyclePage = adminOnly(AdminCycle);
const AdminCycleSetup = adminOnly(CycleSetup);

/** Pages for Admin and the Commercial Director (the API scopes the data too). */
function adminOrCd<P extends object>(Page: (props: P) => preact.JSX.Element): (props: P) => preact.JSX.Element {
  return function CdOnly(props: P) {
    const { user } = useSession();
    return user?.role === 'admin' || (user?.cd?.length ?? 0) > 0 ? <Page {...props} /> : <NotAllowed />;
  };
}
const CdScreen = adminOrCd(CdPage);
const ReportsScreen = adminOrCd(Reports);

function Routes() {
  useLang();
  const { path, url, query, route } = useLocation();
  const { status, user } = useSession();

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

  if (user?.mustChangePw) return <Layout><ChangePassword /></Layout>;

  return (
    <Layout>
      <SaveToast />
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
        <Route path="/admin/months" component={AdminMonths} />
        <Route path="/admin/months/:mid" component={AdminMonthDetail} />
        <Route path="/admin/history" component={AdminHistory} />
        <Route path="/admin/cycle-setup" component={AdminCycleSetup} />
        <Route path="/admin/cycle" component={AdminCyclePage} />
        <Route path="/admin/cycle/:ws" component={AdminCyclePage} />
        <Route path="/admin/cycle/:ws/:period" component={AdminCyclePage} />
        <Route path="/cd" component={CdScreen} />
        <Route path="/cd/:ws" component={CdScreen} />
        <Route path="/cd/:ws/:period" component={CdScreen} />
        <Route path="/reports" component={ReportsScreen} />
        <Route path="/reports/:ws" component={ReportsScreen} />
        <Route path="/reports/:ws/:period" component={ReportsScreen} />
        <Route path="/approve" component={Approve} />
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
