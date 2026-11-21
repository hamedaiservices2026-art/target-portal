// Admin: the months. Open a new month (period + optional deadline), then manage it on its own page.
import { useState } from 'preact/hooks';
import type { MonthListDto } from '../../../worker/services/months';
import { api } from '../../api';
import { errText, Field, LoadError, PageHead, useResource } from '../../components/AdminBits';
import { fmtDeadline, fmtPeriod } from '../../format';
import { t, useLang, type TextKey } from '../../i18n';

export type DeptState = 'loading' | 'running' | 'complete';
export const DEPT_STATE_LABEL: Record<DeptState, TextKey> = {
  loading: 'mcStateLoading', running: 'mcStateRunning', complete: 'mcStateComplete',
};
export const deptStateLabel = (s: string): string => (s in DEPT_STATE_LABEL ? t(DEPT_STATE_LABEL[s as DeptState]) : s);

export function DeptStatePill({ state, testId }: { state: string; testId?: string }) {
  useLang();
  return <span class={`pill dept-${state}`} data-testid={testId}>{deptStateLabel(state)}</span>;
}

/** This month as YYYY-MM, in the viewer's time zone. */
function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function Months() {
  const [lang] = useLang();
  const res = useResource<{ months: MonthListDto[] }>('/api/admin/months');
  const [period, setPeriod] = useState(thisMonth);
  const [deadline, setDeadline] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(e: Event) {
    e.preventDefault();
    setFlash('');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period.trim())) return setErr(t('mcErrPeriod'));
    if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return setErr(t('mcErrDeadline'));
    setBusy(true);
    setErr(null);
    try {
      await api('POST', '/api/admin/months', { period: period.trim(), deadline: deadline || null });
      setFlash(t('mcMonthCreated'));
      res.reload();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="admin-months">
      <PageHead title={t('navMonths')} intro={t('mcMonthsIntro')} />
      <form class="card ad-form" onSubmit={add} noValidate>
        <h2>{t('mcNewMonth')}</h2>
        <div class="grid">
          <Field id="m-period" label={t('mcPeriod')} hint={t('mcPeriodHint')}>
            <input id="m-period" type="month" placeholder="YYYY-MM" value={period} onInput={(e) => setPeriod(e.currentTarget.value)} />
          </Field>
          <Field id="m-deadline" label={t('dsDeadline')} hint={t('mcDeadlineHint')}>
            <input id="m-deadline" type="date" value={deadline} onInput={(e) => setDeadline(e.currentTarget.value)} />
          </Field>
        </div>
        <p class="muted small">{t('mcNewMonthNote')}</p>
        {err && <div class="alert" role="alert">{err}</div>}
        <div class="actions"><button type="submit" class="btn primary" disabled={busy}>{t('mcOpenMonth')}</button></div>
      </form>
      {flash && <div class="banner ok" role="status">{flash}</div>}
      {res.error && <LoadError message={res.error} onRetry={res.reload} />}
      {!res.data && !res.error && <p class="muted">{t('loading')}</p>}
      {res.data && (
        <div class="tablewrap">
          <table class="ad-table">
            <thead>
              <tr>
                <th class="s">{t('month')}</th><th class="s">{t('dsDeadline')}</th>
                <th class="s">{t('mcDepartments')}</th><th class="s">{t('adActions')}</th>
              </tr>
            </thead>
            <tbody>
              {res.data.months.length === 0 && <tr><td class="empty" colSpan={4}>{t('mcNoMonths')}</td></tr>}
              {res.data.months.map((m) => (
                <tr data-testid="month-row" key={m.id}>
                  <td class="s"><b>{fmtPeriod(m.period, lang)}</b> <span class="muted"><bdi>{m.period}</bdi></span></td>
                  <td class="s">{fmtDeadline(m.deadline, lang)}</td>
                  <td class="s">
                    <span class="dept-states">
                      {m.depts.map((d) => (
                        <span class="dept-state" key={d.deptId}><bdi>{d.code}</bdi> <DeptStatePill state={d.state} /></span>
                      ))}
                    </span>
                  </td>
                  <td class="s act"><a class="btn primary" href={`/admin/months/${m.id}`}>{t('open')}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
