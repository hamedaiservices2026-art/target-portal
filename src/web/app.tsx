import { LocationProvider, Route, Router, useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';
import { AUTH_EXPIRED } from './api';
import { Layout } from './components/Layout';
import { t, useLang } from './i18n';
import { Login, safeNext } from './pages/Login';
import { Distribute } from './pages/Distribute';
import { Admin, Branch, Home, NotFound } from './pages/Placeholders';
import { expire, loadSession, useSession } from './session';

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
        <Route path="/m/:mid/n/:nid" component={Distribute} />
        <Route path="/m/:mid/n/:nid/branch" component={Branch} />
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
