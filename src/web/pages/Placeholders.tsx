import type { ComponentChildren } from 'preact';
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
  months: 'navMonths',
  history: 'navHistory',
};

export function Admin({ rest }: { rest?: string }) {
  useLang();
  const { user } = useSession();
  if (user?.role !== 'admin') return <NotAllowed />;
  const section = (rest ?? '').split('/').filter(Boolean)[0] ?? '';
  const key = ADMIN_TITLES[section];
  return key ? <ComingSoon title={t(key)} /> : <NotFound />;
}

export function NotAllowed() {
  useLang();
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
