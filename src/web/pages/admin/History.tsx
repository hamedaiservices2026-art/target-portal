// Admin: history (the audit log), newest first, a page at a time, optionally for one month. Plus the backup download.
import { useEffect, useState } from 'preact/hooks';
import type { AuditRow } from '../../../worker/services/export';
import type { MonthListDto } from '../../../worker/services/months';
import { api } from '../../api';
import { errText, Field, LoadError, PageHead, useResource } from '../../components/AdminBits';
import { fmtDateTime, fmtPeriod } from '../../format';
import { t, useLang, type TextKey } from '../../i18n';

const PAGE = 50;

const ACTION_KEY: Record<string, TextKey> = {
  'backup.download': 'hiBackupDownload', 'dept.create': 'hiDeptCreate', 'dept.update': 'hiDeptUpdate',
  'leaf.create': 'hiLeafCreate', 'leaf.delete': 'hiLeafDelete', 'leaf.update': 'hiLeafUpdate', 'leaves.bulk_map': 'hiLeavesBulkMap',
  'month.batch': 'hiMonthBatch', 'month.create': 'hiMonthCreate', 'month.dept_reset': 'hiDeptReset',
  'month.dept_start': 'hiDeptStart', 'month.export': 'hiMonthExport', 'month.file_add': 'hiFileAdd', 'month.update': 'hiMonthUpdate',
  'node.create': 'hiNodeCreate', 'node.delete': 'hiNodeDelete', 'node.draft': 'hiNodeDraft', 'node.open': 'hiNodeOpen',
  'node.push': 'hiNodePush', 'node.reopen': 'hiNodeReopen', 'node.submit': 'hiNodeSubmit', 'node.update': 'hiNodeUpdate',
  'pack.create': 'hiPackCreate', 'pack.update': 'hiPackUpdate', 'settings.update': 'hiSettingsUpdate',
  'tree.apply_month': 'hiTreeApply', 'user.create': 'hiUserCreate', 'user.password': 'hiUserPassword', 'user.update': 'hiUserUpdate',
};

export function History() {
  const [lang] = useLang();
  const months = useResource<{ months: MonthListDto[] }>('/api/admin/months');
  const [month, setMonth] = useState('');
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  async function load(before: number | null, filter: string, live: () => boolean = () => true) {
    setBusy(true);
    setErr(null);
    try {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (filter) q.set('month', filter);
      if (before !== null) q.set('before', String(before));
      const page = await api<{ rows: AuditRow[]; nextBefore: number | null }>('GET', `/api/admin/audit?${q}`);
      if (!live()) return;
      setRows((old) => (before === null ? page.rows : [...(old ?? []), ...page.rows]));
      setNext(page.nextBefore);
    } catch (x) {
      if (live()) setErr(errText(x));
    } finally {
      if (live()) setBusy(false);
    }
  }

  useEffect(() => {
    let alive = true;
    setRows(null);
    void load(null, month, () => alive);
    return () => void (alive = false);
  }, [month, tick]);

  const periodOf = new Map((months.data?.months ?? []).map((m) => [m.id, m.period]));

  return (
    <section data-testid="admin-history">
      <PageHead title={t('navHistory')} intro={t('hiIntro')}>
        <a class="btn" href="/api/admin/backup" download>{t('hiBackup')}</a>
      </PageHead>
      <p class="muted small">{t('hiBackupNote')}</p>
      <div class="card ad-form">
        <div class="grid">
          <Field id="h-month" label={t('month')}>
            <select id="h-month" value={month} onChange={(e) => setMonth(e.currentTarget.value)}>
              <option value="">{t('hiAllMonths')}</option>
              {(months.data?.months ?? []).map((m) => <option value={String(m.id)}>{`${fmtPeriod(m.period, lang)} (${m.period})`}</option>)}
            </select>
          </Field>
        </div>
      </div>
      {err && <LoadError message={err} onRetry={() => setTick((n) => n + 1)} />}
      {!rows && !err && <p class="muted">{t('loading')}</p>}
      {rows && (
        <div class="tablewrap">
          <table class="ad-table">
            <thead>
              <tr>
                <th class="s">{t('hiWhen')}</th><th class="s">{t('hiWho')}</th><th class="s">{t('hiAction')}</th>
                <th class="s">{t('month')}</th><th class="s">{t('mcDetail')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td class="empty" colSpan={5}>{t('hiEmpty')}</td></tr>}
              {rows.map((r) => (
                <tr key={r.id} data-testid="audit-row">
                  <td class="s">{fmtDateTime(r.at, lang)}</td>
                  <td class="s">{r.userName ?? <span class="muted">{t('hiSystem')}</span>}</td>
                  <td class="s">
                    {ACTION_KEY[r.action] ? t(ACTION_KEY[r.action]!) : r.action}
                    {r.nodeId !== null && <small class="muted"> · {t('node')} #{r.nodeId}</small>}
                  </td>
                  <td class="s">{r.monthId === null ? '—' : <bdi>{periodOf.get(r.monthId) ?? `#${r.monthId}`}</bdi>}</td>
                  <td class="s"><code class="detail" dir="ltr">{r.detail === null ? '' : JSON.stringify(r.detail)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && next !== null && (
        <div class="actions">
          <button type="button" class="btn" disabled={busy} onClick={() => void load(next, month)}>{t('hiLoadMore')}</button>
        </div>
      )}
    </section>
  );
}
