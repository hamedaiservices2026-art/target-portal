// Display formats shared by the manager screens (deadline, month, status words).
import type { NodeStatus } from '../shared/types';
import type { Lang, TextKey } from './i18n';

const dateLocale = (lang: Lang) => (lang === 'ar' ? 'ar-u-ca-gregory-nu-latn' : 'en-GB');

export function fmtDeadline(d: string | null, lang: Lang): string {
  if (!d) return '—';
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : d);
  if (Number.isNaN(date.getTime())) return d;
  return new Intl.DateTimeFormat(dateLocale(lang), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

export function fmtPeriod(period: string, lang: Lang): string {
  const date = new Date(`${period}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return period;
  return new Intl.DateTimeFormat(lang === 'ar' ? dateLocale(lang) : 'en-US', {
    month: lang === 'ar' ? 'long' : 'short', year: 'numeric', timeZone: 'UTC',
  }).format(date);
}

export const STATUS_LABEL: Record<NodeStatus, TextKey> = {
  waiting: 'dsStatusWaiting', in_progress: 'dsStatusInProgress', submitted: 'dsStatusSubmitted',
};
