import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { t, useLang, type TextKey } from '../i18n';
import { logout, useSession } from '../session';
import { tc } from '../cycle/i18n';
import { Bell } from './Bell';
import { LangToggle } from './LangToggle';

export const ADMIN_NAV: { path: string; label: TextKey }[] = [
  { path: '/admin/users', label: 'navUsers' },
  { path: '/admin/departments', label: 'navDepartments' },
  { path: '/admin/packs', label: 'navPacks' },
  { path: '/admin/settings', label: 'navSettings' },
  { path: '/admin/hierarchy', label: 'navHierarchy' },
  { path: '/admin/months', label: 'navMonths' },
  { path: '/admin/history', label: 'navHistory' },
];

export function Layout({ children }: { children?: ComponentChildren }) {
  useLang();
  const { user } = useSession();
  const { path, route } = useLocation();
  const isAdmin = user?.role === 'admin';
  const isCd = (user?.cd?.length ?? 0) > 0;
  const blocked = !!user?.mustChangePw;
  // Target cycle links by role: Admin runs the cycle, the CD splits, Heads approve.
  const cycleNav: { path: string; label: string }[] = blocked ? [] : [
    ...(isAdmin ? [{ path: '/admin/cycle', label: tc('navCycle') }, { path: '/admin/cycle-setup', label: tc('navSetup') }] : []),
    ...(isCd ? [{ path: '/cd', label: tc('navCd') }] : []),
    ...(!isAdmin ? [{ path: '/approve', label: tc('navApprove') }] : []),
    ...(isAdmin || isCd ? [{ path: '/reports', label: tc('navReports') }] : []),
  ];
  const tab = (p: string, label: string) => {
    const on = path === p || path.startsWith(`${p}/`);
    return <a key={p} class={`tab${on ? ' on' : ''}`} href={p} aria-current={path === p ? 'page' : undefined}>{label}</a>;
  };

  async function onLogout() {
    await logout();
    route('/login');
  }

  return (
    <>
      <header class="topbar">
        <a class="logo" href="/">{t('appName')}</a>
        <span class="user" data-testid="user-name">
          {user?.name}
          <span class="role">{isAdmin ? t('roleAdmin') : t('roleManager')}</span>
        </span>
        {!blocked && <Bell />}
        <LangToggle />
        <button type="button" class="btn" data-testid="logout" onClick={onLogout}>{t('logout')}</button>
      </header>
      {!blocked && (isAdmin || cycleNav.length > 0) && (
        <nav class="nav" aria-label={t('mainNav')}>
          <a class={`tab${path === '/' ? ' on' : ''}`} href="/">{t('navHome')}</a>
          {cycleNav.map((n) => tab(n.path, n.label))}
          {isAdmin && ADMIN_NAV.map((n) => tab(n.path, t(n.label)))}
        </nav>
      )}
      <main class="page">{children}</main>
    </>
  );
}
