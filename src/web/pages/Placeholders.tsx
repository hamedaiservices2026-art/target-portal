import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';
import { t, useLang, type TextKey } from '../i18n';
import { useSession } from '../session';

function ComingSoon({ title, children }: { title: string; children?: ComponentChildren }) {
  useLang();
  return (
    <section class="card">
      <h1>{title}</h1>
      {children}
      <p class="muted">{t('comingSoon')}. {t('comingSoonText')}</p>
    </section>
  );
}

const ADMIN_TITLES: Record<string, TextKey> = {
  users: 'navUsers',
  departments: 'navDepartments',
  packs: 'navPacks',
  settings: 'navSettings',
  hierarchy: 'navHierarchy',
};

export function Admin({ rest }: { rest?: string }) {
  useLang();
  const { user } = useSession();
  if (user?.role !== 'admin') return <NotAllowed />;
  const section = (rest ?? '').split('/').filter(Boolean)[0] ?? '';
  const key = ADMIN_TITLES[section];
  return key ? <ComingSoon title={t(key)} /> : <NotFound />;
}

/**
 * A page this person cannot open (a link or a page left open by someone else
 * on this browser): they go straight to their own first page, the Commercial
 * Director screen for a CD, Home for everyone else.
 */
export function NotAllowed() {
  useLang();
  const { user } = useSession();
  const { route } = useLocation();
  const to = user ? ((user.cd?.length ?? 0) > 0 ? '/cd' : '/') : null;
  useEffect(() => { if (to) route(to, true); }, [to]);
  if (to) return <p class="muted">…</p>;
  return (
    <section class="card">
      <h1>{t('forbidden')}</h1>
      <p class="muted">{t('forbiddenText')}</p>
      <a href="/">{t('backHome')}</a>
    </section>
  );
}

export function NotFound() {
  useLang();
  return (
    <section class="card">
      <h1>{t('notFound')}</h1>
      <p class="muted">{t('notFoundText')}</p>
      <a href="/">{t('backHome')}</a>
    </section>
  );
}
