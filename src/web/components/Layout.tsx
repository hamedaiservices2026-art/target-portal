import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { t, useLang, type TextKey } from '../i18n';
import { logout, useSession } from '../session';
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
        <LangToggle />
        <button type="button" class="btn" data-testid="logout" onClick={onLogout}>{t('logout')}</button>
      </header>
      {isAdmin && (
        <nav class="nav" aria-label={t('mainNav')}>
          <a class={`tab${path === '/' ? ' on' : ''}`} href="/">{t('navHome')}</a>
          {ADMIN_NAV.map((n) => {
            const on = path === n.path || path.startsWith(`${n.path}/`);
            return (
              <a class={`tab${on ? ' on' : ''}`} href={n.path} aria-current={path === n.path ? 'page' : undefined}>
                {t(n.label)}
              </a>
            );
          })}
        </nav>
      )}
      <main class="page">{children}</main>
    </>
  );
}
