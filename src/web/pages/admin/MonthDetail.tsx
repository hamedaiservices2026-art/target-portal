// Admin: one month. Deadline, export, and per department: forecast upload (checked
// in the browser first), reset, start, and the status board with reopen / push forward.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { checkForecast, compareToTotals, ForecastHeaderError, normalizeForecastRows, type ForecastCheck } from '../../../shared/forecast';
import type { Issue, IssueCode, NodeStatus } from '../../../shared/types';
import type { MonthContext, MonthListDto } from '../../../worker/services/months';
import type { BoardRow } from '../../../worker/services/flow';
import type { ExportResult } from '../../../worker/services/export';
import { api, ApiError } from '../../api';
import { ConfirmButton, errText, LoadError, PageHead, useResource } from '../../components/AdminBits';
import { StatusPill } from '../../components/StatusPill';
import { readSheet, readSheets, writeXlsx } from '../../excel';
import { fmtDateTime, fmtPeriod } from '../../format';
import { fmtNum, t, tf, useLang, type TextKey } from '../../i18n';
import { groupTotals, parseSheet1, toBatches, type Sheet1 } from '../../monthUpload';
import { DeptStatePill, deptStateLabel } from './Months';

type Month = MonthListDto;
type Dept = Month['depts'][number];

const MAX_SHOWN = 300;

const ISSUE_KEY: Record<IssueCode, TextKey> = {
  unknown_pack: 'mcIssueUnknownPack', period_mismatch: 'mcIssuePeriod', bad_cases: 'mcIssueBadCases',
  duplicate: 'mcIssueDuplicate', unmapped_leaf: 'mcIssueUnmapped', leaf_in_other_file: 'mcIssueOtherFile',
  blank_salesman: 'mcIssueBlankSalesman', blank_cases: 'mcIssueBlankCases', split_salesman: 'mcIssueSplitSalesman', all_zero_leaf: 'mcIssueAllZero',
  missing_pack: 'mcIssueMissingPack', no_rows: 'mcIssueNoRows',
};

const CONFLICT_KEY: Record<string, TextKey> = {
  department_not_loading: 'mcErrNotLoading', leaf_in_other_file: 'mcErrLeafOtherFile',
  leaf_node_not_in_month: 'mcErrLeafNodeNotInMonth', no_files: 'mcErrNoFiles', no_root_node: 'mcErrNoRoot',
  missing_leaves: 'mcErrMissingLeaves', reopen_pending_below: 'mcErrReopenPending', not_submitted: 'mcErrNotSubmitted',
  stale: 'mcErrStale', stale_root_has_leaves: 'mcErrStaleRoot',
};

const plural = (n: number, one: TextKey, many: TextKey) => tf(n === 1 ? one : many, { n: fmtNum(n) });

/** Error text for the month actions: the known 409 reasons in plain words, else the shared wording. */
function monthErr(e: unknown, routeOf?: (leafId: number) => string): string {
  if (e instanceof ApiError) {
    const code = e.status === 413 ? 'too_many_rows' : e.body.error === 'stale' ? 'stale' : String(e.body.detail ?? '');
    if (code === 'too_many_rows') return t('mcErrTooMany');
    const key = CONFLICT_KEY[code];
    if (key) {
      const ids = Array.isArray(e.body.leafIds) ? (e.body.leafIds as number[]) : [];
      const routes = ids.map((id) => (routeOf ? routeOf(id) : `#${id}`)).join(', ');
      return tf(key, { routes, n: fmtNum(ids.length) });
    }
  }
  return errText(e);
}

/** The month's leaves by id, for naming routes in messages (fetched when needed). */
async function routeNamer(monthId: number, deptId: number): Promise<(id: number) => string> {
  try {
    const ctx = await api<MonthContext>('GET', `/api/admin/months/${monthId}/context?dept=${deptId}`);
    const m = new Map(ctx.leaves.map((l) => [l.leafId, `${l.routeCode} (${l.deliverySystem})`]));
    return (id) => m.get(id) ?? `#${id}`;
  } catch {
    return (id) => `#${id}`;
  }
}

// ---------------------------------------------------------------- export

function ExportButton({ month, dept, label, testId }: { month: Month; dept: Dept | 'all'; label: string; testId?: string }) {
  useLang();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<ExportResult | null>(null);
  const tag = dept === 'all' ? 'all' : dept.code;
  const fileName = `targets-${month.period}-${tag}.xlsx`;

  async function download(data: ExportResult) {
    // Every code column is text (a route like 0314 keeps its zero); Cases is a number.
    await writeXlsx(fileName, data.columns, data.rows, data.columns.map((c) => (c === 'Cases' ? 'number' : 'string')));
    setPending(null);
  }
  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const data = await api<ExportResult>('GET', `/api/admin/months/${month.id}/export?dept=${dept === 'all' ? 'all' : dept.deptId}`);
      if (data.departments.some((d) => d.state !== 'complete')) setPending(data);
      else await download(data);
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  const open = pending ? pending.departments.filter((d) => d.state !== 'complete') : [];
  return (
    <span class="export">
      <button type="button" class="btn" disabled={busy} data-testid={testId} onClick={start}>{busy ? t('mcExporting') : label}</button>
      {pending && (
        <div class="banner warn" role="alert" data-testid="export-warning">
          <p>{t('mcExportWarn')}</p>
          <ul>{open.map((d) => <li key={d.id}><bdi>{d.code}</bdi>: {deptStateLabel(d.state)}</li>)}</ul>
          <div class="actions">
            <button type="button" class="btn primary" onClick={() => void download(pending)}>{t('mcDownloadAnyway')}</button>
            <button type="button" class="btn" onClick={() => setPending(null)}>{t('dsCancel')}</button>
          </div>
        </div>
      )}
      {err && <span class="alert" role="alert">{err}</span>}
    </span>
  );
}

// ---------------------------------------------------------------- upload

type Checked = {
  fileName: string;
  sheetName: string;
  ctx: MonthContext;
  result: ForecastCheck;
  rows: number;
  sheet1: (Sheet1 & { fileName: string; diffs: ReturnType<typeof compareToTotals> }) | null;
};
type UploadState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'problem'; message: string }
  | { kind: 'checked'; c: Checked }
  | { kind: 'sending'; c: Checked; done: number; total: number }
  | { kind: 'failed'; c: Checked; message: string; done: number }
  | { kind: 'done'; routes: number; fileName: string };

function IssueTable({ issues, kind }: { issues: Issue[]; kind: 'error' | 'warning' }) {
  useLang();
  if (issues.length === 0) return null;
  const shown = issues.slice(0, MAX_SHOWN);
  return (
    <div class="tablewrap">
      <table class="ad-table issues">
        <thead><tr><th class="s">{t('mcLine')}</th><th class="s">{t('mcProblem')}</th><th class="s">{t('mcDetail')}</th></tr></thead>
        <tbody>
          {shown.map((i, k) => (
            <tr key={k} data-testid={`issue-${kind}`} class={kind === 'error' ? 'issue-bad' : 'issue-warn'}>
              <td class="s">{i.line ?? '—'}</td>
              <td class="s"><b>{t(ISSUE_KEY[i.code])}</b></td>
              <td class="s"><bdi dir="ltr">{i.detail}</bdi></td>
            </tr>
          ))}
        </tbody>
      </table>
      {issues.length > shown.length && <p class="muted small">{tf('adMapMoreErrors', { n: fmtNum(issues.length - shown.length) })}</p>}
    </div>
  );
}

function CheckReport({ c }: { c: Checked }) {
  useLang();
  const { errors, warnings, grids, packTotals } = c.result;
  const g = groupTotals(packTotals, c.ctx.packs);
  return (
    <div class="check-report">
      <p class={`banner ${errors.length ? 'bad' : warnings.length ? 'warn' : 'ok'}`} data-testid="check-summary" role="status">
        <span>
          <b><bdi>{c.fileName}</bdi></b> <span class="small">({tf('mcSheetUsed', { sheet: c.sheetName })})</span>: {plural(errors.length, 'mcErrors1', 'mcErrorsN')}, {plural(warnings.length, 'mcWarnings1', 'mcWarningsN')}.
          {' '}{tf('mcCheckCounts', { rows: fmtNum(c.rows), routes: fmtNum(grids.length) })}
          {' '}{errors.length ? t('mcErrorsBlock') : warnings.length ? t('mcWarningsOk') : t('mcAllGood')}
        </span>
      </p>
      {errors.length > 0 && <><h3>{t('mcErrorsTitle')}</h3><IssueTable issues={errors} kind="error" /></>}
      {warnings.length > 0 && <><h3>{t('mcWarningsTitle')}</h3><IssueTable issues={warnings} kind="warning" /></>}

      {c.sheet1 && (
        <>
          <h3>{tf('mcSheet1Title', { file: c.sheet1.fileName })}</h3>
          {c.sheet1.invalid.length > 0 && (
            <p class="banner warn">{tf('mcSheet1Invalid', { lines: c.sheet1.invalid.map((x) => `${x.line} (${x.pack})`).join(', ') })}</p>
          )}
          {c.sheet1.unrecognised.length > 0 && (
            <p class="banner warn" data-testid="sheet1-unrecognised">
              {tf('mcSheet1Unrecognised', { rows: c.sheet1.unrecognised.map((x) => `${x.line} (${x.pack}: ${fmtNum(Math.round(x.total))})`).join(', ') })}
            </p>
          )}
          {c.sheet1.diffs.length === 0 ? (
            <p class="banner ok" data-testid="sheet1-match">{t('mcSheet1Match')}</p>
          ) : (
            <>
              <p class="muted">{plural(c.sheet1.diffs.length, 'mcSheet1Diff1', 'mcSheet1DiffN')}</p>
              <div class="tablewrap">
                <table class="ad-table narrow-table">
                  <thead>
                    <tr><th class="s">{t('dsColPack')}</th><th>{t('mcForecast')}</th><th>{t('mcSheet1')}</th><th>{t('mcDifference')}</th></tr>
                  </thead>
                  <tbody>
                    {c.sheet1.diffs.map((d) => (
                      <tr key={d.pack} data-testid="sheet1-diff">
                        <td class="s"><bdi>{d.pack}</bdi></td>
                        <td>{fmtNum(d.forecast)}</td><td>{fmtNum(d.expected)}</td>
                        <td><bdi dir="ltr">{d.diff > 0 ? `+${fmtNum(d.diff)}` : fmtNum(d.diff)}</bdi></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {grids.length > 0 && (
        <div data-testid="pack-totals">
          <h3>{t('mcTotalsTitle')}</h3>
          <div class="totals">
            {g.groups.map((x) => (
              <div class="card" key={x.grp}><span class="k">{x.grp}</span><span class="v">{fmtNum(x.cases)}</span></div>
            ))}
            <div class="card"><span class="k">{t('branchTotal')}</span><span class="v">{fmtNum(g.total)}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

function UploadPanel({ month, dept, onUploaded, onSending }: {
  month: Month; dept: Dept; onUploaded: () => void; onSending: (sending: boolean) => void;
}) {
  useLang();
  const [state, setState] = useState<UploadState>({ kind: 'idle' });
  const sending = state.kind === 'sending';
  useEffect(() => onSending(sending), [sending]);
  useEffect(() => () => onSending(false), []);
  const forecast = useRef<File | null>(null);
  const sheet1 = useRef<File | null>(null);
  const run = useRef(0);

  async function check() {
    const file = forecast.current;
    if (!file) return;
    const me = ++run.current;
    const set = (s: UploadState) => { if (me === run.current) setState(s); };
    set({ kind: 'checking' });
    let ctx: MonthContext;
    try {
      ctx = await api<MonthContext>('GET', `/api/admin/months/${month.id}/context?dept=${dept.deptId}`);
    } catch (x) {
      return set({ kind: 'problem', message: errText(x) });
    }
    let sheets: { sheet: string; data: unknown[][] }[];
    try {
      sheets = await readSheets(file);
    } catch {
      return set({ kind: 'problem', message: t('adMapErrUnreadable') });
    }
    // The forecast may be on any sheet (the TT DMM workbook has the totals first): use the first sheet with the header.
    let rows: ReturnType<typeof normalizeForecastRows> | null = null;
    let sheetName = '';
    let best: string[] | null = null;
    for (const sh of sheets) {
      try {
        rows = normalizeForecastRows(sh.data);
        sheetName = sh.sheet;
        break;
      } catch (x) {
        if (!(x instanceof ForecastHeaderError)) return set({ kind: 'problem', message: t('errGeneric') });
        if (best === null || x.missing.length < best.length) best = x.missing;
      }
    }
    if (rows === null) return set({ kind: 'problem', message: tf('mcErrHeader', { columns: (best ?? []).join(', ') }) });
    const codes = ctx.packs.map((p) => p.code);
    const result = checkForecast(rows, {
      period: ctx.period,
      packs: codes,
      leaves: new Map(ctx.leaves.map((l) => [`${l.deliverySystem}|${l.routeCode}`, l.leafId])),
      takenLeafIds: new Set(ctx.takenLeafIds),
    });
    let s1: Checked['sheet1'] = null;
    if (sheet1.current) {
      try {
        const parsed = parseSheet1(await readSheet(sheet1.current), codes);
        if (Object.keys(parsed.totals).length === 0 && parsed.invalid.length === 0 && parsed.unrecognised.length === 0) {
          return set({ kind: 'problem', message: t('mcSheet1Empty') });
        }
        s1 = { ...parsed, fileName: sheet1.current.name, diffs: compareToTotals(result.packTotals, parsed.totals) };
      } catch {
        return set({ kind: 'problem', message: t('mcSheet1Unreadable') });
      }
    }
    set({ kind: 'checked', c: { fileName: file.name, sheetName, ctx, result, rows: rows.length, sheet1: s1 } });
  }

  function pick(which: 'forecast' | 'sheet1') {
    return (e: Event) => {
      const input = e.currentTarget as HTMLInputElement;
      const f = input.files?.[0] ?? null;
      (which === 'forecast' ? forecast : sheet1).current = f;
      input.value = ''; // so choosing the same file again (after fixing it, or after an upload) runs again
      if (forecast.current) void check();
      else setState({ kind: 'idle' });
    };
  }

  async function send(c: Checked) {
    const batches = toBatches(c.result.grids);
    const total = c.result.grids.length;
    let done = 0;
    setState({ kind: 'sending', c, done, total });
    try {
      const { fileId } = await api<{ fileId: number }>('POST', `/api/admin/months/${month.id}/files`, {
        deptId: dept.deptId, name: c.fileName, ...(c.sheet1 ? { sheet1: c.sheet1.totals } : {}),
      });
      for (const grids of batches) {
        await api('POST', `/api/admin/months/${month.id}/files/${fileId}/batch`, { grids });
        done += grids.length;
        setState({ kind: 'sending', c, done, total });
      }
    } catch (x) {
      const namer = x instanceof ApiError && Array.isArray(x.body.leafIds) ? await routeNamer(month.id, dept.deptId) : undefined;
      setState({ kind: 'failed', c, message: monthErr(x, namer), done });
      onUploaded();
      return;
    }
    forecast.current = null;
    sheet1.current = null;
    setState({ kind: 'done', routes: total, fileName: c.fileName });
    onUploaded();
  }

  const busy = state.kind === 'checking' || state.kind === 'sending';
  const c = state.kind === 'checked' || state.kind === 'sending' || state.kind === 'failed' ? state.c : null;
  const canAccept = state.kind === 'checked' && state.c.result.errors.length === 0 && state.c.result.grids.length > 0;

  return (
    <div class="upload-panel" data-testid="upload-panel">
      <ol class="steps">
        <li>{t('mcUploadStep1')}</li>
        <li>{t('mcUploadStep2')}</li>
        <li>{t('mcUploadStep3')}</li>
      </ol>
      <div class="actions">
        <span class="filepick">
          <input id={`fc-${dept.deptId}`} type="file" class="visually-hidden" data-testid="forecast-file" disabled={busy}
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={pick('forecast')} />
          <label for={`fc-${dept.deptId}`} class={`btn primary${busy ? ' disabled' : ''}`}>{t('mcChooseForecast')}</label>
        </span>
        <span class="filepick">
          <input id={`s1-${dept.deptId}`} type="file" class="visually-hidden" data-testid="sheet1-file" disabled={busy}
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={pick('sheet1')} />
          <label for={`s1-${dept.deptId}`} class={`btn${busy ? ' disabled' : ''}`}>{t('mcChooseSheet1')}</label>
        </span>
      </div>
      <p class="muted small">
        {forecast.current ? tf('mcChosenForecast', { file: forecast.current.name }) : t('mcNoForecastYet')}
        {sheet1.current ? ` · ${tf('mcChosenSheet1', { file: sheet1.current.name })}` : ''}
      </p>
      <p class="muted small">{t('mcSheet1Help')}</p>

      {state.kind === 'checking' && <p class="muted" role="status">{t('adMapWorking')}</p>}
      {state.kind === 'problem' && <div class="alert" role="alert" data-testid="upload-problem">{state.message}</div>}
      {c && <CheckReport c={c} />}

      {state.kind === 'checked' && (
        <div class="actions">
          <button type="button" class="btn primary" disabled={!canAccept} onClick={() => void send(state.c)}>{t('mcAccept')}</button>
          {!canAccept && <span class="muted small">{t('mcAcceptBlocked')}</span>}
        </div>
      )}
      {state.kind === 'sending' && (
        <div class="progress" role="status">
          <progress max={state.total} value={state.done} aria-label={t('mcSending')} />
          <span>{tf('mcSendingN', { done: fmtNum(state.done), total: fmtNum(state.total) })}</span>
        </div>
      )}
      {state.kind === 'failed' && (
        <div class="alert" role="alert" data-testid="upload-failed">
          <b>{t('mcUploadStopped')}</b> {state.message}
          <p>{tf('mcUploadStoppedHelp', { done: fmtNum(state.done) })}</p>
        </div>
      )}
      {state.kind === 'done' && (
        <div class="banner ok" role="status" data-testid="upload-done">
          {tf('mcUploadDone', { routes: fmtNum(state.routes), file: state.fileName })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- board

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back to showing the link */ }
  return false;
}

function Board({ month, dept, onDeptChanged }: { month: Month; dept: Dept; onDeptChanged: () => void }) {
  const [lang] = useLang();
  const res = useResource<BoardRow[]>(`/api/admin/months/${month.id}/board?dept=${dept.deptId}`);
  // Messages are kept as functions so they follow a language switch.
  const [flash, setFlash] = useState<(() => string) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [shownLink, setShownLink] = useState<number | null>(null);
  const rows = res.data ?? [];

  const depth = useMemo(() => {
    const d = new Map<number, number>();
    for (const r of rows) d.set(r.nodeId, r.parentId === null ? 0 : (d.get(r.parentId) ?? 0) + 1);
    return d;
  }, [rows]);

  async function act(call: () => Promise<() => string>) {
    setErr(null);
    setFlash(null);
    try {
      const msg = await call();
      setFlash(() => msg);
    } catch (x) {
      setErr(monthErr(x));
    }
    res.reload();
    onDeptChanged();
  }
  const reopen = (r: BoardRow) => act(async () => {
    await api('POST', `/api/admin/months/${month.id}/nodes/${r.nodeId}/reopen`);
    return () => tf('mcReopened', { node: r.name });
  });
  const push = (r: BoardRow) => act(async () => {
    const out = await api<{ used: 'draft' | 'baseline' }>('POST', `/api/admin/months/${month.id}/nodes/${r.nodeId}/push`);
    return () => tf(out.used === 'draft' ? 'mcPushedDraft' : 'mcPushedBaseline', { node: r.name });
  });
  async function copy(r: BoardRow) {
    setErr(null);
    if (await copyText(r.link)) {
      setShownLink(null);
      setFlash(() => () => tf('mcLinkCopied', { node: r.name }));
    } else {
      setFlash(null);
      setShownLink(r.nodeId);
    }
  }

  return (
    <div class="board">
      <div class="ad-card-head">
        <h3>{t('mcBoardTitle')}</h3>
        <button type="button" class="btn" onClick={() => { res.reload(); onDeptChanged(); }}>{t('mcRefresh')}</button>
      </div>
      {flash && <div class="banner ok" role="status" data-testid="board-flash">{flash()}</div>}
      {err && <div class="alert" role="alert" data-testid="board-error">{err}</div>}
      {res.error && <LoadError message={res.error} onRetry={res.reload} />}
      {!res.data && !res.error && <p class="muted">{t('loading')}</p>}
      {res.data && (
        <div class="tablewrap">
          <table class="ad-table board-table">
            <thead>
              <tr>
                <th class="s">{t('node')}</th><th class="s">{t('adManager')}</th><th class="s">{t('adStatus')}</th>
                <th class="s">{t('mcOpenedAt')}</th><th class="s">{t('mcSubmittedAt')}</th><th class="s">{t('adActions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td class="empty" colSpan={6}>{t('mcBoardEmpty')}</td></tr>}
              {rows.map((r) => (
                <tr key={r.nodeId} data-testid="board-row">
                  <td class="s"><span class="board-name" style={{ '--depth': depth.get(r.nodeId) ?? 0 }}>{r.name}</span></td>
                  <td class="s">
                    {r.manager ?? <span class="muted">{t('adNoManager')}</span>}
                    {!r.manager && <small class="muted hint">{t('mcNoManagerHint')}</small>}
                  </td>
                  <td class="s"><StatusPill status={r.status as NodeStatus} testId="board-status" /></td>
                  <td class="s">{fmtDateTime(r.openedAt, lang)}</td>
                  <td class="s">{fmtDateTime(r.submittedAt, lang)}</td>
                  <td class="s act">
                    {r.status === 'submitted' && (
                      <button type="button" class="btn" onClick={() => void reopen(r)}>{t('mcReopen')}</button>
                    )}
                    {r.status === 'in_progress' && (
                      <ConfirmButton
                        label={t('mcPush')} question={tf('mcPushQ', { node: r.name })} yesLabel={t('mcPushYes')}
                        danger={false} onConfirm={() => push(r)}
                      />
                    )}
                    <button type="button" class="btn" onClick={() => void copy(r)}>{t('mcCopyLink')}</button>
                    {shownLink === r.nodeId && (
                      <input class="link-box" readOnly value={r.link} aria-label={t('mcLinkBox')}
                        ref={(el) => el?.select()} onFocus={(e) => e.currentTarget.select()} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- department

function DeptCard({ month, dept, onChanged }: { month: Month; dept: Dept; onChanged: () => void }) {
  useLang();
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<(() => string) | null>(null);
  const loading = dept.state === 'loading';

  useEffect(() => { if (!loading) setUploading(false); }, [loading]);
  // A message stays until the department changes state for another reason (a manager's submit, the board).
  const acted = useRef(false);
  const say = (fn: () => string) => { acted.current = true; setFlash(() => fn); };
  useEffect(() => {
    if (acted.current) acted.current = false;
    else setFlash(null);
  }, [dept.state]);

  async function start() {
    setBusy(true);
    setErr(null);
    setFlash(null);
    try {
      await api('POST', `/api/admin/months/${month.id}/depts/${dept.deptId}/start`);
      say(() => t('mcStarted'));
      setUploading(false);
    } catch (x) {
      const namer = x instanceof ApiError && Array.isArray(x.body.leafIds) ? await routeNamer(month.id, dept.deptId) : undefined;
      setErr(monthErr(x, namer));
    } finally {
      setBusy(false);
      onChanged();
    }
  }
  async function refreshTree() {
    setBusy(true);
    setErr(null);
    setFlash(null);
    try {
      const r = await api<{ added: number; removed: number }>('POST', `/api/admin/months/${month.id}/depts/${dept.deptId}/refresh-tree`);
      say(() => tf('mcRefreshTreeDone', { dept: dept.name, added: fmtNum(r.added), removed: fmtNum(r.removed) }));
    } catch (x) {
      setErr(monthErr(x));
    } finally {
      setBusy(false);
      onChanged();
    }
  }
  async function reset() {
    setErr(null);
    setFlash(null);
    try {
      await api('POST', `/api/admin/months/${month.id}/depts/${dept.deptId}/reset`);
      say(() => tf('mcResetDone', { dept: dept.name }));
      setUploading(false);
    } catch (x) {
      setErr(monthErr(x));
    }
    onChanged();
  }

  return (
    <section class="card ad-card dept-card" data-testid="dept-card">
      <div class="ad-card-head">
        <h2><bdi>{dept.code}</bdi> — {dept.name}</h2>
        <DeptStatePill state={dept.state} testId="dept-state" />
      </div>
      <p class="muted">
        <span data-testid="dept-files">{tf('mcFilesN', { n: fmtNum(dept.files) })}</span>
        {' · '}{tf('mcRoutesLoaded', { n: fmtNum(dept.leaves) })}
        {' · '}{t(loading ? 'mcStateLoadingHelp' : dept.state === 'running' ? 'mcStateRunningHelp' : 'mcStateCompleteHelp')}
      </p>
      <div class="actions">
        {loading && (
          <button type="button" class={`btn${uploading ? '' : ' primary'}`} aria-expanded={uploading} onClick={() => setUploading(!uploading)}>
            {uploading ? t('mcCloseUpload') : t('mcUpload')}
          </button>
        )}
        {loading && (
          <button type="button" class="btn primary" disabled={busy || sending || dept.files === 0} title={dept.files === 0 ? t('mcErrNoFiles') : undefined} onClick={start}>
            {t('mcStart')}
          </button>
        )}
        {loading && (
          <button type="button" class="btn" disabled={busy || sending} data-testid="refresh-tree" onClick={refreshTree}>
            {t('mcRefreshTree')}
          </button>
        )}
        <ExportButton month={month} dept={dept} label={t('mcExport')} />
        <ConfirmButton
          label={t('mcReset')} question={tf('mcResetQ', { dept: dept.name })} yesLabel={t('mcResetYes')} onConfirm={reset}
          disabled={sending} title={sending ? t('mcResetWhileSending') : undefined}
        />
      </div>
      {flash && <div class="banner ok" role="status">{flash()}</div>}
      {err && <div class="alert" role="alert" data-testid="dept-error">{err}</div>}
      {loading && uploading && <UploadPanel month={month} dept={dept} onUploaded={onChanged} onSending={setSending} />}
      {!loading && <Board month={month} dept={dept} onDeptChanged={onChanged} />}
    </section>
  );
}

// ---------------------------------------------------------------- page

function DeadlineEditor({ month, onSaved }: { month: Month; onSaved: () => void }) {
  useLang();
  const [value, setValue] = useState(month.deadline ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setValue(month.deadline ?? ''), [month.deadline]);

  async function save(e: Event) {
    e.preventDefault();
    setSaved(false);
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return setErr(t('mcErrDeadline'));
    setBusy(true);
    setErr(null);
    try {
      await api('PATCH', `/api/admin/months/${month.id}`, { deadline: value || null });
      setSaved(true);
      onSaved();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form class="inline-form" onSubmit={save} noValidate>
      <label for="md-deadline">{t('dsDeadline')}</label>
      <input id="md-deadline" type="date" value={value} onInput={(e) => { setValue(e.currentTarget.value); setSaved(false); }} />
      <button type="submit" class="btn" disabled={busy}>{t('mcSaveDeadline')}</button>
      {saved && <small class="ok-text" role="status" data-testid="deadline-flash">{value ? t('mcDeadlineSaved') : t('mcDeadlineCleared')}</small>}
      {err && <div class="alert" role="alert">{err}</div>}
      <small class="muted">{t('mcDeadlineNote')}</small>
    </form>
  );
}

export function MonthDetail({ mid = '' }: { mid?: string }) {
  const [lang] = useLang();
  const res = useResource<{ months: MonthListDto[] }>('/api/admin/months');
  const id = Number(mid);
  const month = res.data?.months.find((m) => m.id === id) ?? null;

  if (res.error) return <LoadError message={res.error} onRetry={res.reload} />;
  if (!res.data) return <p class="muted">{t('loading')}</p>;
  if (!month) {
    return (
      <section class="card">
        <h1>{t('notFound')}</h1>
        <p class="muted">{t('mcMonthGone')}</p>
        <a href="/admin/months">{t('mcBackToMonths')}</a>
      </section>
    );
  }
  return (
    <section data-testid="admin-month">
      <p class="crumbs"><a href="/admin/months">{t('navMonths')}</a></p>
      <PageHead title={`${fmtPeriod(month.period, lang)} (\u2068${month.period}\u2069)`} intro={t('mcMonthIntro')}>
        <ExportButton month={month} dept="all" label={t('mcExportAll')} />
      </PageHead>
      <div class="card ad-card"><DeadlineEditor month={month} onSaved={res.reload} /></div>
      {month.depts.length === 0 && <p class="card muted">{t('mcNoDepts')}</p>}
      {month.depts.map((d) => (
        <DeptCard key={d.deptId} month={month} dept={d} onChanged={res.reload} />
      ))}
    </section>
  );
}
