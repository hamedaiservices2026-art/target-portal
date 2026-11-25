// Admin › Target cycle (handover sections 3, 4, 6, 9): the 5-step start with
// every upload, the Commercial Director hand-off, the target calculator, the
// send / restart control per Head of Department, route targets and variance.
import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { useContext, useEffect, useMemo, useState } from 'preact/hooks';
import { CATEGORIES, packKey } from '../../../shared/calc/packs';
import { PACK_GROUPS } from '../../../shared/imports';
import { pago as pagoOf } from '../../../shared/calc/periods';
import { CalcTab } from './AdminCalc';
import { WorkflowTab } from './AdminWorkflow';
import * as T from '../../cycle/templates';
import type { Workspace } from '../../../worker/auth';
import type { CycleDto, CycleSettings } from '../../../worker/services/cycle';
import type { DataStatus, OrgDto } from '../../../worker/services/cycleData';
import type { KaLink } from '../../../worker/services/accounts';
import { KaCalcTab } from './KaCalc';
import { DeptColumnsStep } from './DeptColumns';
import { deptColumns, orderedDeptCols } from '../../cycle/deptOrder';
import { NextStep, type TabId } from './NextStep';
import type { ExportResult } from '../../../worker/services/export';
import { api } from '../../api';
import { ConfirmButton, errText, PageHead } from '../../components/AdminBits';
import { readSheet, readSheets } from '../../excel';
import { fmtDateTime } from '../../format';
import { fmtNum, useLang } from '../../i18n';
import { catMap, cdRows, defaultDeptSplit, NO_CHANNEL, prevTargetMonths, startNewTarget, subMap, sumCat, total, type Grid, type NtSource } from '../../cycle/compute';
import { tc } from '../../cycle/i18n';
import { clearRouteCache, getCycle, getOrg, loadMonthData, loadRouteData, useAsync } from '../../cycle/load';
import {
  packIndex, parseAop, parseChannelGrid, parseNewTargetByLeaf, parseNewTargetByPack, parsePrevTargets, parseAopByDept, parseSales, sheetMonth,
  type Check, type FileRow, type RouteMonthData,
} from '../../cycle/parsers';
import { Checks, defaultPeriod, rowColour, PacksAdded, PacksVersion, downloadCsv, fmtCases, NumCell, Section, Tabs, writeWorkbook, WsPeriod } from '../../cycle/ui';

export type Loaded = { cycle: CycleDto; org: OrgDto; status: DataStatus; ops?: CycleDto; links?: KaLink[]; ka?: CycleDto };
type NtUpload = { mode: 'pack' | 'dept' | 'leaf' | 'aop'; byPack: Grid; byChannel?: Record<string, Grid>; byLeaf?: Record<string, Grid>; byKam?: Record<string, Grid>; file?: string; layout?: FileRow[] };
/** One month of the AOP by department: channel grids, with the file's row order (older uploads: the grids only). */
type AopDeptMonth = Record<string, Grid> | { byChannel: Record<string, Grid>; layout: FileRow[] };
const aopDeptOf = (v: AopDeptMonth | undefined): { byChannel: Record<string, Grid>; layout: FileRow[] } | null =>
  !v ? null : 'byChannel' in v && 'layout' in v ? (v as { byChannel: Record<string, Grid>; layout: FileRow[] }) : { byChannel: v as Record<string, Grid>, layout: [] };

const BATCH = 200;

async function uploadRoutes(ws: Workspace, kind: 'sales' | 'prev_target', data: RouteMonthData, extra: Record<string, Record<string, unknown>> | null, file: string, onProgress: (n: number) => void): Promise<number> {
  const months = Object.keys(data).sort();
  await api('POST', `/api/admin/data/${ws}/routes/clear`, { kind, months });
  const rows: { month: string; routeCode: string; values: Grid; extra?: unknown }[] = [];
  for (const m of months) for (const [r, v] of Object.entries(data[m]!)) rows.push({ month: m, routeCode: r, values: v, ...(extra?.[m]?.[r] ? { extra: extra[m]![r] } : {}) });
  for (let i = 0; i < rows.length; i += BATCH) {
    await api('POST', `/api/admin/data/${ws}/routes`, { kind, rows: rows.slice(i, i + BATCH) });
    onProgress(Math.min(rows.length, i + BATCH));
  }
  await api('POST', `/api/admin/data/${ws}/log`, { kind, months, count: rows.length, file });
  clearRouteCache(ws);
  return rows.length;
}

export async function uploadMonths(ws: Workspace, kind: 'new_target' | 'aop' | 'fy_target' | 'dept_channel' | 'aop_dept', byMonth: Record<string, unknown>): Promise<number> {
  const months = Object.keys(byMonth).sort();
  for (const m of months) await api('POST', `/api/admin/data/${ws}/months`, { kind, month: m, values: byMonth[m] });
  return months.length;
}

function has(status: DataStatus, kind: string, month: string): boolean {
  return status.some((s) => s.kind === kind && s.month === month);
}

/** One upload step: template, file, checks, confirm. */
function UploadStep({ ws, clearKind, n, title, help, template, done, locked, parse, upload, multiSheet, loaded, children }: {
  /** What "Remove the previous data" clears before the upload (every month of this kind). */
  ws?: Workspace; clearKind?: { table: 'routes' | 'months'; kind: string };
  n: number | null; title: string; help: string; template: () => Promise<void>; done: boolean; locked: boolean;
  loaded?: string | null; children?: ComponentChildren;
  parse: (input: { rows?: unknown[][]; sheets?: { sheet: string; data: unknown[][] }[] }) => { checks: Check[]; summary: string; payload: unknown };
  upload: (payload: unknown, file: string, progress: (n: number) => void) => Promise<string>;
  multiSheet?: boolean;
}) {
  useLang();
  const [parsed, setParsed] = useState<{ checks: Check[]; summary: string; payload: unknown; file: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [replace, setReplace] = useState(false);
  const [input, setInput] = useState<{ rows?: unknown[][]; sheets?: { sheet: string; data: unknown[][] }[] } | null>(null);
  const packsVer = useContext(PacksVersion);
  // Packs were added to the pack master from this file's check: read the file again with them.
  useEffect(() => {
    if (input && parsed) setParsed({ ...parse(input), file: parsed.file });
  }, [packsVer]);

  async function onFile(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!f) return;
    setErr(null);
    setMsg(null);
    try {
      const inp = multiSheet ? { sheets: await readSheets(f) } : { rows: await readSheet(f) };
      setInput(inp);
      setParsed({ ...parse(inp), file: f.name });
    } catch (x) {
      setErr(`${tc('fileUnreadable')} (${x instanceof Error ? x.message : ''})`);
    }
  }

  async function onUpload() {
    if (!parsed) return;
    setBusy(true);
    setErr(null);
    try {
      if (replace && ws && clearKind) await api('POST', `/api/admin/data/${ws}/clear-all`, clearKind);
      setMsg(await upload(parsed.payload, parsed.file, setProgress));
      setParsed(null);
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
      setProgress(0);
    }
  }
  const blocking = parsed?.checks.some((c) => c.level === 'error') ?? false;

  return (
    <div class={`cy-step${done ? ' done' : ''}`} data-testid={`step-${n ?? 'extra'}`}>
      <div class="cy-step-head">
        <span class="cy-step-n">{done ? '✓' : n ?? '•'}</span>
        <div><b>{title}</b><p class="muted small">{help}</p></div>
        <span class="spacer" />
        <button type="button" class="btn" onClick={() => void template().catch((x) => setErr(errText(x)))}>{tc('downloadTemplate')}</button>
      </div>
      {children}
      {loaded && <p class="small muted" data-testid="loaded">{loaded}</p>}
      {locked ? <p class="muted small">{tc('uploadsLocked')}</p> : (
        <div class="cy-step-body">
          <input type="file" accept=".xlsx,.xls" aria-label={title} onChange={onFile} />
          {parsed && (
            <>
              <p class="small">{parsed.summary}</p>
              <Checks checks={parsed.checks} />
              {ws && clearKind && (
                <fieldset class="cy-keep" data-testid="keep-or-replace">
                  <label class="small"><input type="radio" checked={!replace} onChange={() => setReplace(false)} /> {tc('keepPrev')}</label>{' '}
                  <label class="small"><input type="radio" checked={replace} onChange={() => setReplace(true)} data-testid="replace-prev" /> {tc('replacePrev')}</label>
                </fieldset>
              )}
              <div class="actions">
                <button type="button" class="btn primary" disabled={busy || blocking} onClick={() => void onUpload()}>
                  {busy ? (progress ? tc('uploadingN', { n: fmtNum(progress) }) : tc('uploading')) : tc('upload')}
                </button>
                <button type="button" class="btn" disabled={busy} onClick={() => setParsed(null)}>{tc('cancel')}</button>
              </div>
            </>
          )}
        </div>
      )}
      {msg && <div class="banner ok" role="status">{msg}</div>}
      {err && <div class="alert" role="alert">{err}</div>}
    </div>
  );
}

// ---------- step 1: cycle settings ----------

function SettingsStep({ ws, period, cycle, exists, onSaved }: { ws: Workspace; period: string; cycle: CycleDto; exists: boolean; onSaved: () => void }) {
  useLang();
  const [s, setS] = useState<CycleSettings>(cycle.settings);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api('PUT', `/api/admin/cycle/${ws}/${period}/settings`, { deadlines: s.deadlines });
      // One step for both: the deadlines apply to Operation and Key Account.
      const other: Workspace = ws === 'ops' ? 'ka' : 'ops';
      await api('PUT', `/api/admin/cycle/${other}/${period}/settings`, { deadlines: s.deadlines });
      onSaved();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  const dl = (k: 'head' | 'manager' | 'supervisor', label: string) => (
    <label class="field">
      <span>{label}</span>
      <input type="date" value={s.deadlines[k] ?? ''} onChange={(e) => setS({ ...s, deadlines: { ...s.deadlines, [k]: e.currentTarget.value || null } })} />
    </label>
  );
  return (
    <div class={`cy-step${exists ? ' done' : ''}`} data-testid="step-1">
      <div class="cy-step-head">
        <span class="cy-step-n">{exists ? '✓' : 1}</span>
        <div><b>{tc('step1Both')}</b><p class="muted small">{tc('step1Help', { period, pago: pagoOf(period), yago: `${Number(period.slice(0, 4)) - 1}${period.slice(4)}` })} {tc('step1BothHelp')}</p></div>
        <span class="spacer" />
      </div>
      <div class="cy-grid">
        {dl('head', tc('dlHead'))}
        {dl('manager', tc('dlManager'))}
        {dl('supervisor', tc('dlSupervisor'))}
      </div>
      <p class="muted small">{tc('capInSetup')} <a href="/admin/cycle-setup">{tc('navSetup')}</a></p>
      <div class="actions">
        <button type="button" class="btn primary" disabled={busy} onClick={() => void save()}>{exists ? tc('save') : tc('openCycle')}</button>
      </div>
      {err && <div class="alert" role="alert">{err}</div>}
    </div>
  );
}

// ---------- step 8: send ----------

function SendStep({ ws, period, l, onDone, missing }: { ws: Workspace; period: string; l: Loaded; onDone: () => void; missing: string[] }) {
  useLang();
  const { cycle, org } = l;
  const [preview, setPreview] = useState<{ nt: Grid; source: NtSource; upload: NtUpload | null; split?: Record<string, Grid> | null; splitBasis?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [deptChecks, setDeptChecks] = useState<Check[]>([]);
  const cats = catMap(org);
  const subOf = subMap(org.packs);

  async function prepare() {
    setBusy(true);
    setErr(null);
    try {
      const [nt, fy, aop, dc] = await Promise.all([
        loadMonthData<NtUpload>(ws, 'new_target'),
        loadMonthData<Grid>(ws, 'fy_target'), loadMonthData<Record<string, { cases: number; nr: number | null }>>(ws, 'aop'),
        loadMonthData<Record<string, Grid>>(ws, 'dept_channel'),
      ]);
      const pm = pagoOf(period);
      const months = [pm, `${period.slice(0, 4)}-${period.slice(5)}`].concat(cycle.settings.avgMonths);
      const [sales, prev] = await Promise.all([loadRouteData(ws, 'sales', cycle.settings.avgMonths), loadRouteData(ws, 'prev_target', months)]);
      const up = nt[period] ?? null;
      const r = startNewTarget(period, { newTarget: up ? { mode: up.mode === 'dept' ? 'dept' : 'pack', byPack: up.byPack, byChannel: up.byChannel } : null, fyTarget: fy, aop, deptChannel: dc, prevTargets: prev.data, sales: sales.data }, cats);
      if (total(r.nt) === 0) {
        setErr(tc('sendNoNt', { list: missing.length ? missing.join(' · ') : tc('step2', { period }) }));
        return;
      }
      // By pack or from the AOP: split by department the way the CD's screen does (previous targets, else average sales).
      let split: Record<string, Grid> | null = null;
      let splitBasis = '';
      if (up?.mode !== 'dept') {
        const d = defaultDeptSplit({ period, nt: r.nt, org, sales: sales.data, avgMonths: cycle.settings.avgMonths, deptChannel: dc, byPrevTarget: true });
        split = {};
        for (const ch of Object.values(d.dm)) for (const [c, g] of Object.entries(ch)) if (c !== NO_CHANNEL) split[c] = g;
        splitBasis = prevTargetMonths(dc, cycle.settings.avgMonths).length ? tc('previewSplitPrev') : tc('previewSplitSales');
      }
      setPreview({ ...r, upload: up, split, splitBasis });
    } catch (x) {
      setErr(tc('sendPrepareFailed', { e: errText(x) }));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!preview) return;
    setBusy(true);
    setErr(null);
    try {
      await api('POST', `/api/admin/cycle/${ws}/${period}/cd/send`, { nt: preview.nt });
      setPreview(null);
      onDone();
    } catch (x) {
      setErr(tc('sendFailed', { e: errText(x) }) + (missing.length ? ` ${tc('sendFailedMissing', { list: missing.join(' · ') })}` : ''));
    } finally {
      setBusy(false);
    }
  }

  async function recall() {
    setBusy(true);
    try {
      await api('POST', `/api/admin/cycle/${ws}/${period}/cd/recall`, {});
      onDone();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  async function putDept(dept: Record<string, Grid>) {
    await api('PUT', `/api/admin/cycle/${ws}/${period}/dept-target`, { dept });
    onDone();
  }

  async function deptFile(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!f) return;
    setErr(null);
    try {
      const channels = org.depts.flatMap((d) => d.channels.map((c) => c.channel));
      const groups = Object.fromEntries(org.depts.flatMap((d) => d.channels.map((c) => [c.channel, c.grp])));
      const r = parseChannelGrid(await readSheet(f), channels, packIndex(org.packs.map((p) => p.code)), groups);
      setDeptChecks(r.checks);
      if (r.checks.some((c) => c.level === 'error')) return;
      const dept: Record<string, Grid> = {};
      for (const d of org.depts) {
        const g: Grid = {};
        for (const c of d.channels) for (const [p, n] of Object.entries(r.byChannel[c.channel] ?? {})) g[p] = (g[p] ?? 0) + n;
        dept[String(d.id)] = g;
      }
      await putDept(dept);
    } catch (x) {
      setErr(errText(x));
    }
  }

  /** CD step off: the uploaded New Target becomes the department target (by channel, by KAE, or one Head). */
  async function fromUpload(auto = false) {
    setErr(null);
    setBusy(true);
    try {
      const up = (await loadMonthData<NtUpload>(ws, 'new_target'))[period];
      if (!up && auto) return;
      if (!up) throw new Error(tc('noUploadYet'));
      if (auto && up.mode !== 'dept') return;
      const dept: Record<string, Grid> = {};
      const addTo = (d: string, g: Grid) => { const t = (dept[d] ??= {}); for (const [p, n] of Object.entries(g)) t[p] = (t[p] ?? 0) + n; };
      if (up.mode === 'dept' && up.byChannel) {
        for (const d of org.depts) for (const c of d.channels) addTo(String(d.id), up.byChannel[c.channel] ?? {});
      } else if (up.mode === 'leaf' && up.byLeaf) {
        const deptOf = new Map(org.leaves.map((x) => [x.routeCode, String(x.deptId)]));
        let lost = 0;
        for (const [leaf, g] of Object.entries(up.byLeaf)) {
          const d = deptOf.get(leaf);
          if (d) addTo(d, g); else lost += total(g);
        }
        if (lost) setDeptChecks([{ level: 'warning', text: tc('leafLost', { n: fmtNum(lost) }) }]);
      } else if (org.depts.length === 1) {
        addTo(String(org.depts[0]!.id), up.byPack);
      } else {
        throw new Error(tc('uploadNotByDept'));
      }
      await putDept(dept);
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  // Uploaded by department: no CD; the upload is the department target straight away (next: calculate by route).
  useEffect(() => {
    if (!cycle.settings.cdStep && cycle.dept === null) void fromUpload(true);
  }, [cycle.settings.cdStep, cycle.dept === null, cycle.version]);
  const done = cycle.settings.cdStep ? cycle.cdStatus === 'with_cd' || cycle.cdStatus === 'submitted' : cycle.dept !== null;
  const srcLabel: Record<NtSource, string> = {
    uploaded: tc('srcUploaded'), fy_target: tc('srcFy'), aop_ratio: tc('srcAop'), pago_target: tc('srcPago'), avg_sales: tc('srcAvg'), none: tc('srcNone'),
  };
  // The table shown before sending: every pack with the CD workbook subtotals (and the department split when uploaded by department).
  // Same columns as the CD screen: TT DMM, TT Outer, Total TT, MT, MT SSV, MT Bulk, Total MT, HoReCa, WS.
  const byCh = preview?.upload?.mode === 'dept' ? preview.upload.byChannel ?? null : preview?.split ?? null;
  const grid = byCh ? deptColumns(orderedDeptCols(org.depts.filter((d) => d.channels.length), '_'), (name) => tc('totalOf', { name })) : null;
  const deptCols = grid ? grid.flat.map((x) => (x.kind === 'cell'
    ? { id: `${x.d.id}${x.c}`, name: x.c, head: x.d.name, tot: false, g: byCh![x.c] ?? {} }
    : { id: `t${x.label}`, name: x.label, head: '', tot: true, g: x.cells.reduce<Grid>((acc, k) => { for (const [p, n] of Object.entries(byCh![k.c] ?? {})) acc[p] = (acc[p] ?? 0) + n; return acc; }, {}) })) : [];
  return (
    <div class={`cy-step${done ? ' done' : ''}`} data-testid="step-6">
      <div class="cy-step-head">
        <span class="cy-step-n">{done ? '✓' : 3}</span>
        <div><b>{tc('step8')}</b><p class="muted small">{cycle.settings.cdStep ? tc('step8HelpCd') : tc('step8HelpNoCd')}</p></div>
      </div>
      {cycle.cdStatus === 'returned' && cycle.cdComment && <div class="banner warn">{tc('cdReturnedWith')} <q>{cycle.cdComment}</q></div>}
      {cycle.settings.cdStep ? (
        <div class="cy-step-body">
          <p>{tc('cdStatus')}: <b data-testid="cd-status">{tc(`cd_${cycle.cdStatus}` as 'cd_draft')}</b></p>
          {(cycle.cdStatus === 'draft' || cycle.cdStatus === 'returned') && missing.length > 0 && (
            <div class="banner warn" data-testid="send-missing" role="alert">
              <b>{tc('sendMissingTitle')}</b>
              <ul>{missing.map((m) => <li key={m}>{m}</li>)}</ul>
              {tc('sendMissingHelp')}
            </div>
          )}
          {(cycle.cdStatus === 'draft' || cycle.cdStatus === 'returned') && !preview && (
            <button type="button" class="btn" disabled={busy} onClick={() => void prepare()}>{tc('prepareNt')}</button>
          )}
          {preview && (
            <>
              <p>{tc('ntSource')}: <b>{srcLabel[preview.source]}</b> · {tc('ntTotal')}: <b>{fmtNum(total(preview.nt))}</b>
                {' · '}{CATEGORIES.map((c) => `${c} ${fmtNum(sumCat(preview.nt, cats, c))}`).join(' · ')}</p>
              <div class="banner info small" data-testid="preview-split">{preview.upload?.mode === 'dept' ? tc('previewSplitUploaded') : `${preview.splitBasis ?? ''} ${tc('previewSplitCd')}`}</div>
              <div class="tablewrap cy-tall"><table class="ad-table cy-table" data-testid="nt-preview">
                <thead>
                  {grid && <tr><th /><th />{grid.heads.map((h) => (h.kind === 'dept' ? <th key={`h${h.d.id}`} colSpan={h.span} class="grp">{h.d.name}</th> : <th key={`t${h.label}`} />))}<th /></tr>}
                  <tr><th>{tc('pack')}</th><th>{tc('subCategory')}</th>{deptCols.map((d) => <th key={d.id} class={`num${d.tot ? ' tot' : ''}`}>{d.name}</th>)}<th class="num">{grid ? 'ABC' : tc('newTarget')}</th></tr>
                </thead>
                <tbody>{cdRows(Object.keys(preview.nt), cats).map((r) => {
                  const list = r.kind === 'sub' ? r.packs : [r.pack];
                  const sum = (g: Grid) => list.reduce((s, p) => s + (g[p] ?? 0), 0);
                  return (
                    <tr key={r.kind === 'sub' ? r.label : r.pack} class={r.kind === 'sub' ? `sub l${r.level}` : ''}>
                      <td><bdi>{r.kind === 'sub' ? r.label : r.pack}</bdi></td><td class="small muted">{r.kind === 'pack' ? subOf(r.pack) : ''}</td>
                      {deptCols.map((d) => <td key={d.id} class={`num${d.tot ? ' tot' : ''}`}>{fmtNum(sum(d.g))}</td>)}
                      <td class="num"><b>{fmtNum(sum(preview.nt))}</b></td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
              <div class="actions">
                <button type="button" class="btn primary" disabled={busy || total(preview.nt) === 0} onClick={() => void send()}>{tc('sendToCd')}</button>
                <button type="button" class="btn" onClick={() => setPreview(null)}>{tc('cancel')}</button>
              </div>
            </>
          )}
          {(cycle.cdStatus === 'with_cd' || cycle.cdStatus === 'submitted') && (
            <ConfirmButton label={tc('recall')} question={tc('recallQ')} yesLabel={tc('recall')} onConfirm={recall} />
          )}
        </div>
      ) : (
        <div class="cy-step-body">
          <p class="muted small">{tc('deptFileHelp')}</p>
          <div class="actions">
            <button type="button" class="btn primary" disabled={busy} onClick={() => void fromUpload()}>{tc('deptFromUpload')}</button>
          </div>
          <input type="file" accept=".xlsx,.xls" aria-label={tc('step8')} onChange={deptFile} />
          <Checks checks={deptChecks} />
          {cycle.dept && <p class="small">{tc('deptTargetSet', { n: fmtNum(Object.values(cycle.dept).reduce((s, g) => s + total(g), 0)) })}</p>}
        </div>
      )}
      {err && <div class="alert" role="alert">{err}</div>}
    </div>
  );
}

// ---------- step 2, AOP by pack and department ----------

/** The AOP by pack and department (all months of the year, one sheet per channel); the target month's part becomes the New Target. */
function AopDeptStep({ ws, period, org, saved, modePicker, onSaved }: {
  ws: Workspace; period: string; org: OrgDto; saved: NtUpload | null; modePicker: ComponentChildren; onSaved: (msg: string) => void;
}) {
  useLang();
  const data = useAsync(() => loadMonthData<AopDeptMonth>('ops', 'aop_dept'), [period]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const idx = useMemo(() => packIndex(org.packs.map((p) => p.code)), [org]);
  const channels = org.depts.flatMap((d) => d.channels.map((c) => c.channel));
  const months = Object.keys(data.data ?? {}).sort();
  const mineAll = aopDeptOf(data.data?.[period]);
  const mine = mineAll?.byChannel ?? null;
  const used = saved?.mode === 'dept' && (saved.file ?? '').startsWith('AOP');
  async function use() {
    if (!mine) return;
    setBusy(true); setErr(null);
    try {
      const byPack: Grid = {};
      for (const g of Object.values(mine)) for (const [p, n] of Object.entries(g)) byPack[p] = (byPack[p] ?? 0) + n;
      // Goes to the CD like every AOP option; the CD sees the AOP split by department.
      await uploadMonths(ws, 'new_target', { [period]: { mode: 'dept', byPack, byChannel: mine, layout: mineAll?.layout ?? [], file: `AOP by department ${period}` } });
      onSaved(tc('aopDeptUsed', { period, total: fmtNum(total(byPack)) }));
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div class="cy-step" data-testid="step-2"><div class="cy-step-head"><span class="cy-step-n">2</span><div><b>{tc('step2', { period })}</b>
        <p class="muted small">{tc('aopDeptInFiles')} {months.length ? tc('loadedMonths', { from: months[0]!, to: months[months.length - 1]!, n: months.length }) : ''}</p></div></div>{modePicker}</div>
      <div class={`cy-step${used ? ' done' : ''}`} data-testid="aop-dept-use">
        <div class="cy-step-head"><span class="cy-step-n">{used ? '✓' : '•'}</span>
          <div><b>{tc('aopDeptUseTitle', { period })}</b><p class="muted small">{mine ? tc('aopDeptUseHelp', { total: fmtNum(Object.values(mine).reduce((s2, g) => s2 + total(g), 0)) }) : tc('aopDeptNone', { period })}</p></div></div>
        <div class="cy-step-body">
          {mine && !used && <FileTargetTable org={org} g={mine} layout={mineAll?.layout ?? []} />}
          <button type="button" class="btn primary" data-testid="aop-dept-use-btn" disabled={busy || !mine} onClick={() => void use()}>{used ? tc('aopDeptUseAgain') : tc('aopDeptUse')}</button>
          {err && <div class="alert" role="alert">{err}</div>}
        </div>
      </div>
    </>
  );
}

/** Uploaded files › AOP by pack and department (all months of the year, one sheet per channel). */
function AopDeptUpload({ ws, period, org, n, children }: { ws: Workspace; period: string; org: OrgDto; n: number; children?: ComponentChildren }) {
  useLang();
  const data = useAsync(() => loadMonthData<AopDeptMonth>('ops', 'aop_dept'), [period]);
  const idx = useMemo(() => packIndex(org.packs.map((p) => p.code)), [org]);
  const channels = org.depts.flatMap((d) => d.channels.map((c) => c.channel));
  const months = Object.keys(data.data ?? {}).sort();
  return (
    <UploadStep ws={ws} clearKind={{ table: 'months', kind: 'aop_dept' }} n={n} title={`${tc('step3')} · ${tc('aopDeptTitle')}`} help={tc('aopDeptHelp')}
      template={() => T.aopByDept(org, period)} done={!!aopDeptOf(data.data?.[period])} locked={false} multiSheet
      loaded={months.length ? tc('loadedMonths', { from: months[0]!, to: months[months.length - 1]!, n: months.length }) : null}
      parse={({ sheets }) => {
        const r = parseAopByDept(sheets!, channels, idx);
        const payload = Object.fromEntries(Object.entries(r.byMonth).map(([m, g]) => [m, { byChannel: g, layout: r.layout }]));
        return { checks: r.checks, summary: tc('sumMonths', { n: Object.keys(r.byMonth).length }), payload };
      }}
      upload={async (p) => { const k = await uploadMonths(ws, 'aop_dept', p as Record<string, unknown>); data.reload(); return tc('savedMonths', { n: k }); }}>
      {children}
    </UploadStep>
  );
}

// ---------- step 2 by department: the uploaded target, editable ----------


/**
 * The target by pack and department as in the file: packs in the file's order
 * with the file's Total rows, heads and channels as columns, a grand total.
 * Editable when onChange is given (changed cells are marked against `base`).
 */
function FileTargetTable({ org, g, layout: layoutRaw, base, onChange }: {
  org: OrgDto; g: Record<string, Grid>; layout: FileRow[]; base?: Record<string, Grid>; onChange?: (channel: string, pack: string, n: number) => void;
}) {
  useLang();
  const cats = catMap(org);
  const pidx = useMemo(() => packIndex(org.packs.map((p) => p.code)), [org]);
  const code = (n: string) => pidx.get(packKey(n)) ?? n;
  const layout = layoutRaw.map((x): FileRow => ('p' in x ? { p: code(x.p) } : { t: x.t, of: [...new Set(x.of.map(code))] }));
  const grid = deptColumns(orderedDeptCols(org.depts.filter((d) => d.channels.length), '_'), (name) => tc('totalOf', { name }));
  const cells = grid.flat.filter((x) => x.kind === 'cell').map((x) => (x.kind === 'cell' ? x.c : ''));
  const all = [...new Set([...Object.values(g).flatMap((x) => Object.keys(x)), ...layout.flatMap((x) => ('p' in x ? [x.p] : []))])];
  // The file's order; packs not in the file (added later) follow, by category.
  const inFile = new Set(layout.flatMap((x) => ('p' in x ? [x.p] : [])));
  const rest = cdRows(all.filter((p) => !inFile.has(p)), cats).flatMap((x) => (x.kind === 'pack' ? [x.pack] : []));
  const rows: FileRow[] = layout.length ? [...layout.filter((x) => 'p' in x || x.of.length), ...rest.map((p) => ({ p }))]
    : cdRows(all, cats).map((x) => (x.kind === 'pack' ? { p: x.pack } : { t: x.label, of: x.packs }));
  const covered = rows.some((x) => 't' in x && all.every((p) => x.of.includes(p)));
  const v = (c: string, list: string[]) => list.reduce((t, p) => t + (g[c]?.[p] ?? 0), 0);
  const sumCells = (cs: string[], list: string[]) => cs.reduce((t, c) => t + v(c, list), 0);
  const line = (list: string[]) => sumCells(cells, list);
  const grand = line(all);
  const heads = org.depts.filter((d) => d.channels.length).map((d) => ({ name: d.name, n: sumCells(d.channels.map((c) => c.channel), all) }));
  const totalDepth = (x: { of: string[] }) => (x.of.length === all.length ? 'grand' : x.of.length > all.length / 3 ? 'big' : 'mid');
  return (
    <div class="ft">
      <div class="ft-chips" data-testid="ft-chips">
        {heads.map((h) => <span key={h.name} class="ft-chip"><span>{h.name}</span><b>{fmtNum(h.n)}</b><i>{grand ? `${((h.n / grand) * 100).toFixed(1)}%` : ''}</i></span>)}
        <span class="ft-chip total"><span>{tc('total')}</span><b>{fmtNum(grand)}</b></span>
      </div>
      <div class="tablewrap cy-tall"><table class="ad-table cy-table ft-table" data-testid="file-target-table">
        <thead>
          <tr><th class="ft-pack" />{grid.heads.map((h) => (h.kind === 'dept' ? <th key={`h${h.d.id}`} colSpan={h.span} class="grp">{h.d.name}</th> : <th key={`t${h.label}`} />))}<th /></tr>
          <tr><th class="ft-pack">{tc('pack')}</th>{grid.flat.map((x) => (x.kind === 'cell' ? <th key={`${x.d.id}${x.c}`} class="num">{x.c}</th> : <th key={`t${x.label}`} class="num tot">{x.label}</th>))}<th class="num ft-sum">{tc('total')}</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const list = 'p' in r ? [r.p] : r.of;
            const isTot = 't' in r;
            return (
              <tr key={isTot ? `t${i}${r.t}` : r.p} class={isTot ? `ft-total ${totalDepth(r)}` : 'ft-row'} style={rowColour(isTot ? r.t : r.p)}>
                <td class="ft-pack"><bdi>{isTot ? r.t : r.p}</bdi></td>
                {grid.flat.map((x) => {
                  if (x.kind !== 'cell') return <td key={`t${x.label}`} class="num tot">{fmtNum(sumCells(x.cells.map((k) => k.c), list))}</td>;
                  if (isTot || !onChange) return <td key={`${x.d.id}${x.c}`} class="num">{fmtNum(v(x.c, list))}</td>;
                  const p = (r as { p: string }).p;
                  const now = g[x.c]?.[p] ?? 0;
                  const edited = base && now !== (base[x.c]?.[p] ?? 0);
                  return <td key={`${x.d.id}${x.c}`} class={`num${edited ? ' ft-edited' : ''}`}><NumCell value={now} label={`${p} ${x.c}`} onChange={(n) => onChange(x.c, p, n)} /></td>;
                })}
                <td class="num ft-sum"><b>{fmtNum(line(list))}</b></td>
              </tr>
            );
          })}
          {!covered && (
            <tr class="ft-total grand">
              <td class="ft-pack">{tc('total')}</td>
              {grid.flat.map((x) => <td key={x.kind === 'cell' ? `${x.d.id}${x.c}` : `t${x.label}`} class={`num${x.kind === 'cell' ? '' : ' tot'}`}>{fmtNum(x.kind === 'cell' ? v(x.c, all) : sumCells(x.cells.map((k) => k.c), all))}</td>)}
              <td class="num ft-sum"><b>{fmtNum(grand)}</b></td>
            </tr>
          )}
        </tbody>
      </table></div>
    </div>
  );
}

/** The target uploaded by pack and department, as uploaded (CD columns), editable before the next steps. */
function DeptUploadTable({ ws, period, org, nt, cdStep, onSaved }: { ws: Workspace; period: string; org: OrgDto; nt: NtUpload; cdStep: boolean; onSaved: (msg: string) => void }) {
  useLang();
  const [g, setG] = useState<Record<string, Grid>>(() => JSON.parse(JSON.stringify(nt.byChannel ?? {})) as Record<string, Grid>);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const changed = JSON.stringify(g) !== JSON.stringify(nt.byChannel ?? {});
  async function save() {
    setBusy(true); setErr(null);
    try {
      const byPack: Grid = {};
      for (const x of Object.values(g)) for (const [p, n] of Object.entries(x)) byPack[p] = (byPack[p] ?? 0) + n;
      await uploadMonths(ws, 'new_target', { [period]: { ...nt, mode: 'dept', byPack, byChannel: g } });
      // The file's own layout is kept (nt.layout).
      // The department target follows the upload (no CD when uploaded by department).
      const dept: Record<string, Grid> = {};
      for (const d of org.depts) {
        const t: Grid = {};
        for (const c of d.channels) for (const [p, n] of Object.entries(g[c.channel] ?? {})) t[p] = (t[p] ?? 0) + n;
        dept[String(d.id)] = t;
      }
      if (!cdStep) await api('PUT', `/api/admin/cycle/${ws}/${period}/dept-target`, { dept });
      onSaved(cdStep ? tc('duSavedCd') : tc('duSaved'));
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="cy-step" data-testid="dept-upload-table">
      <div class="cy-step-head"><span class="cy-step-n">✎</span><div><b>{tc('duTitle', { period })}</b><p class="muted small">{tc('duHelp')}</p></div></div>
      <div class="cy-step-body">
        <FileTargetTable org={org} g={g} layout={nt.layout ?? []} base={nt.byChannel ?? {}}
          onChange={(c, p, n) => setG((o) => ({ ...o, [c]: { ...(o[c] ?? {}), [p]: Math.max(0, Math.round(n)) } }))} />
        <div class="actions">
          <button type="button" class="btn primary" data-testid="du-save" disabled={busy} onClick={() => void save()}>{tc('duSave')}</button>
          {changed && <button type="button" class="btn" onClick={() => setG(JSON.parse(JSON.stringify(nt.byChannel ?? {})) as Record<string, Grid>)}>{tc('resetAllEdits')}</button>}
        </div>
        {err && <div class="alert" role="alert">{err}</div>}
      </div>
    </div>
  );
}

// ---------- step 2 with the AOP option: the AOP of the target month, editable ----------

/** The AOP of the target month as the new target by pack: change, delete or add packs, then save. */
function AopTargetStep({ ws, period, org, saved, locked, modePicker, onSaved, onPacksChanged }: {
  ws: Workspace; period: string; org: OrgDto; saved: NtUpload | null; locked: boolean; modePicker: ComponentChildren; onSaved: (msg: string) => void; onPacksChanged: () => void;
}) {
  useLang();
  // Key Accounts use the AOP uploaded in Operation (no second upload).
  const aop = useAsync(() => loadMonthData<Record<string, { cases: number; nr: number | null }>>('ops', 'aop'), [period]);
  const fromAop = useMemo<Grid>(() => Object.fromEntries(Object.entries(aop.data?.[period] ?? {}).map(([p, v]) => [p, Math.max(0, Math.round(v.cases))])), [aop.data, period]);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [add, setAdd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cats = catMap(org);
  const start = saved?.mode === 'aop' ? saved.byPack : fromAop;
  const g = grid ?? start;
  const packs = cdRows(Object.keys(g), cats);
  // Every pack of the pack master (inactive ones too, e.g. CSD_SSPET500 or PMIX), plus a new code typed by the admin.
  const free = org.packs.filter((p) => !(p.code in g));
  const [newCode, setNewCode] = useState('');
  const [newGrp, setNewGrp] = useState('CSD');
  const edited = grid !== null;
  const done = saved?.mode === 'aop';

  const added = useAsync(() => api<{ packs: string[] }>('GET', '/api/admin/packs-added'), [org]);
  /** A pack the admin added: new name in the pack master and in this target. */
  async function renamePack(code: string, raw: string) {
    const to = raw.trim();
    if (!to || to === code) return;
    setErr(null);
    try {
      await api('POST', `/api/admin/packs/${encodeURIComponent(code)}/rename`, { code: to });
      if (code in g) { const next: Grid = {}; for (const [k, v] of Object.entries(g)) next[k === code ? to : k] = v; setGrid(next); }
      onPacksChanged();
    } catch (x) {
      setErr(errText(x));
    }
  }
  /** A pack the admin added: out of the pack master and of this target. */
  async function deletePack(code: string) {
    setErr(null);
    try {
      await api('DELETE', `/api/admin/packs/${encodeURIComponent(code)}`);
      if (code in g) { const next = { ...g }; delete next[code]; setGrid(next); }
      onPacksChanged();
    } catch (x) {
      setErr(errText(x));
    }
  }
  /** Adds a pack of the master (turned on again when it is inactive, so the calculation uses it). */
  async function addPack(code: string) {
    setErr(null);
    try {
      const p = org.packs.find((x) => x.code === code);
      if (p && !p.active) await api('PATCH', `/api/admin/packs/${encodeURIComponent(code)}`, { active: true });
      setGrid({ ...g, [code]: 0 });
      setAdd('');
    } catch (x) {
      setErr(errText(x));
    }
  }
  /** A pack code that is not in the pack master yet: added to the master with its category, then to the target. */
  async function addNewPack() {
    const code = newCode.trim();
    const known = org.packs.find((x) => x.code.toLowerCase() === code.toLowerCase());
    if (known) { setNewCode(''); return addPack(known.code); }
    setBusy(true);
    setErr(null);
    try {
      await api('POST', '/api/admin/packs', { code, grp: newGrp, active: true });
      setGrid({ ...g, [code]: 0 });
      setNewCode('');
      onPacksChanged();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const byPack = Object.fromEntries(Object.entries(g).filter(([, n]) => n > 0));
      await uploadMonths(ws, 'new_target', { [period]: { mode: 'aop', byPack, file: `AOP ${period}` } });
      setGrid(null);
      onSaved(tc('aopSaved', { n: Object.keys(byPack).length, total: fmtNum(total(byPack)) }));
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class={`cy-step${done ? ' done' : ''}`} data-testid="step-2">
      <div class="cy-step-head">
        <span class="cy-step-n">{done ? '✓' : 2}</span>
        <div><b>{tc('step2', { period })}</b><p class="muted small">{tc('step2AopHelp', { period })}</p></div>
      </div>
      {modePicker}
      {aop.error && <div class="alert">{aop.error}</div>}
      {!aop.data ? <p class="muted">{tc('loading')}</p> : Object.keys(start).length === 0 ? (
        <div class="banner warn" data-testid="aop-missing">{ws === 'ka' ? tc('aopMissingKa', { period }) : tc('aopMissing', { period })}</div>
      ) : (
        <>
          <p class="small">{tc('ntTotal')}: <b data-testid="aop-total">{fmtNum(total(g))}</b> · {CATEGORIES.map((c) => `${c} ${fmtNum(sumCat(g, cats, c))}`).join(' · ')}
            {done && !edited && <span class="pill ok">{tc('aopSavedPill')}</span>}{edited && <span class="pill warn">{tc('notSavedYet')}</span>}</p>
          <div class="tablewrap cy-tall"><table class="ad-table cy-table" data-testid="aop-table">
            <thead><tr><th>{tc('pack')}</th><th class="num">{tc('aopCol')}</th><th class="num">{tc('newTarget')}</th><th /></tr></thead>
            <tbody>{packs.map((r) => {
              if (r.kind === 'sub') {
                return <tr key={r.label} class={`sub l${r.level}`}><td>{r.label}</td><td class="num">{fmtNum(r.packs.reduce((s2, p) => s2 + (fromAop[p] ?? 0), 0))}</td><td class="num">{fmtNum(r.packs.reduce((s2, p) => s2 + (g[p] ?? 0), 0))}</td><td /></tr>;
              }
              return (
                <tr key={r.pack}>
                  <td><bdi>{r.pack}</bdi></td>
                  <td class="num muted">{fmtNum(fromAop[r.pack] ?? 0)}</td>
                  <td class="num">{locked ? fmtNum(g[r.pack] ?? 0) : <NumCell value={g[r.pack] ?? 0} label={`${tc('newTarget')} ${r.pack}`} onChange={(n) => setGrid({ ...g, [r.pack]: n })} />}</td>
                  <td>{!locked && <button type="button" class="btn link danger" aria-label={`${tc('remove')} ${r.pack}`} onClick={() => { const next = { ...g }; delete next[r.pack]; setGrid(next); }}>{tc('remove')}</button>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
          {!locked && (
            <div class="toolbar">
              <select aria-label={tc('addPack')} value={add} onChange={(e) => setAdd(e.currentTarget.value)}>
                <option value="">{tc('addPack')}</option>
                {free.map((p) => <option key={p.code} value={p.code}>{p.code}</option>)}
              </select>
              <button type="button" class="btn" disabled={!add} data-testid="aop-add" onClick={() => void addPack(add)}>{tc('urAddIt')}</button>
              <input value={newCode} placeholder={tc('aopNewPack')} aria-label={tc('aopNewPack')} style={{ width: '11em' }} onInput={(e) => setNewCode(e.currentTarget.value)} />
              <select aria-label={tc('category')} value={newGrp} onChange={(e) => setNewGrp(e.currentTarget.value)}>
                {PACK_GROUPS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <button type="button" class="btn" disabled={!newCode.trim() || busy} data-testid="aop-add-new" onClick={() => void addNewPack()}>{tc('aopAddNew')}</button>
              <span class="spacer" />
              {edited && <button type="button" class="btn" onClick={() => setGrid(null)}>{tc('undoAll')}</button>}
              <button type="button" class="btn primary" data-testid="aop-save" disabled={busy || total(g) === 0} onClick={() => void save()}>{tc('aopUse')}</button>
            </div>
          )}
          {!locked && (added.data?.packs.length ?? 0) > 0 && (
            <details class="cy-added" data-testid="aop-added">
              <summary>{tc('aopAddedTitle', { n: added.data!.packs.length })}</summary>
              <p class="small muted">{tc('aopAddedHelp')}</p>
              <table class="ad-table cy-table"><tbody>{added.data!.packs.map((code) => (
                <tr key={code}>
                  <td><input defaultValue={code} aria-label={`${tc('aopRename')} ${code}`} data-testid={`aop-name-${code}`} onChange={(e) => void renamePack(code, e.currentTarget.value)} /></td>
                  <td><ConfirmButton testId={`aop-del-${code}`} label={tc('remove')} question={tc('aopDeleteQ', { code })} yesLabel={tc('remove')} onConfirm={() => deletePack(code)} /></td>
                </tr>
              ))}</tbody></table>
            </details>
          )}
        </>
      )}
      {err && <div class="alert" role="alert">{err}</div>}
    </div>
  );
}

// ---------- Key Accounts step 2 option: from the Operation target ----------

function KaFromOpsStep({ period, l, modePicker, onChanged }: { period: string; l: Loaded; modePicker: ComponentChildren; onChanged: () => void }) {
  useLang();
  const { org } = l;
  const opsOrg = useAsync(() => getOrg('ops'), []);
  const [err, setErr] = useState<string | null>(null);
  const links = l.links ?? [];
  const opsDept = l.ops?.dept ?? null;
  const opsDepts = opsOrg.data?.depts ?? [];
  const linked = links.filter((x) => x.opsDeptId !== null);
  const ready = linked.length > 0 && !!opsDept && linked.every((x) => opsDept[String(x.opsDeptId)]);
  async function link(kaDeptId: number, v: string) {
    setErr(null);
    try {
      await api('PUT', `/api/admin/ka-links/${kaDeptId}`, { opsDeptId: v ? Number(v) : null });
      onChanged();
    } catch (x) {
      setErr(errText(x));
    }
  }
  return (
    <div class={`cy-step${ready ? ' done' : ''}`} data-testid="step-2">
      <div class="cy-step-head">
        <span class="cy-step-n">{ready ? '✓' : 2}</span>
        <div><b>{tc('step2', { period })}</b><p class="muted small">{tc('kaFromOpsHelp')}</p></div>
      </div>
      {modePicker}
      {org.depts.length === 0 ? <div class="banner warn">{tc('kaNoDepts')}</div> : (
        <div class="tablewrap"><table class="ad-table cy-table" data-testid="ka-links">
          <thead><tr><th>{tc('kaDept')}</th><th>{tc('kaOpsDept')}</th><th class="num">{tc('kaOpsTarget', { period })}</th></tr></thead>
          <tbody>{org.depts.map((d) => {
            const lk = links.find((x) => x.kaDeptId === d.id);
            const t = lk?.opsDeptId != null ? opsDept?.[String(lk.opsDeptId)] : undefined;
            return (
              <tr key={d.id}>
                <td><b>{d.name}</b></td>
                <td>
                  <select aria-label={`${tc('kaOpsDept')} ${d.name}`} value={lk?.opsDeptId != null ? String(lk.opsDeptId) : ''} onChange={(e) => void link(d.id, e.currentTarget.value)}>
                    <option value="">{tc('kaPickOps')}</option>
                    {opsDepts.map((o) => <option key={o.id} value={String(o.id)}>{o.name}{o.channels.length ? ` (${o.channels.map((c) => c.channel).join(', ')})` : ''}</option>)}
                  </select>
                </td>
                <td class="num">{t ? <b>{fmtNum(total(t))}</b> : <span class="muted small">{lk?.opsDeptId != null ? tc('kaOpsNotReady') : '—'}</span>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {!opsDept && linked.length > 0 && <p class="banner warn small">{tc('kaOpsWaiting', { period })}</p>}
      <p class="muted small">{tc('kaLinkHelp')}</p>
      {err && <div class="alert" role="alert">{err}</div>}
    </div>
  );
}

// ---------- Key Accounts step 4: previous targets by KAM and KAE, with a note ----------

function KaNote({ period, cycle, onSaved }: { period: string; cycle: CycleDto; onSaved: () => void }) {
  useLang();
  const [note, setNote] = useState(cycle.settings.note ?? '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api('PUT', `/api/admin/cycle/ka/${period}/settings`, { note });
      onSaved();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="cy-note">
      <label class="field"><span>{tc('kaNote')}</span>
        <textarea rows={3} value={note} data-testid="ka-note" placeholder={tc('kaNotePh')} onInput={(e) => setNote(e.currentTarget.value)} />
      </label>
      <div class="actions"><button type="button" class="btn" disabled={busy || note === (cycle.settings.note ?? '')} onClick={() => void save()}>{tc('kaNoteSave')}</button></div>
    </div>
  );
}

// ---------- tab: start ----------

/** `part`: 'files' = the uploaded files (AOP, sales, previous targets); 'start' = the cycle, the new target and the send. */
function StartTab({ ws, period, l, reload, part }: { ws: Workspace; period: string; l: Loaded; reload: () => void; part: 'files' | 'start' }) {
  useLang();
  const { cycle, org, status } = l;
  const exists = cycle.version > 0 || cycle.updatedAt !== '';
  const idx = useMemo(() => packIndex(org.packs.map((p) => p.code)), [org]);
  const channels = org.depts.flatMap((d) => d.channels.map((c) => c.channel));
  const groups = Object.fromEntries(org.depts.flatMap((d) => d.channels.map((c) => [c.channel, c.grp])));
  const routes = new Set(org.leaves.map((x) => x.routeCode));
  const locked = cycle.cdStatus === 'with_cd' || cycle.cdStatus === 'submitted';
  const cats = catMap(org);
  const [modeBusy, setModeBusy] = useState(false);
  const [revertMsg, setRevertMsg] = useState<string | null>(null);
  const ntData = useAsync(exists ? () => loadMonthData<NtUpload>(ws, 'new_target') : null, [ws, period, cycle.version, status.length]);
  const nt = ntData.data?.[period] ?? null;
  const ka = ws === 'ka';
  const mode = cycle.settings.ntMode;
  const after = (msg: string) => { reload(); ntData.reload(); return msg; };
  const ntDone = mode === 'ops' ? (l.links ?? []).some((x) => x.opsDeptId !== null && !!l.ops?.dept?.[String(x.opsDeptId)])
    : mode === 'aop' ? nt?.mode === 'aop' : has(status, 'new_target', period);
  const salesDone = cycle.settings.avgMonths.every((m) => has(status, 'sales', m));
  const prevDone = ka ? status.some((s) => s.kind === 'prev_target') : status.some((s) => s.kind === 'dept_channel');
  const done = ka
    ? [exists, ntDone, salesDone, prevDone]
    : [exists, ntDone, status.some((s) => s.kind === 'aop' || s.kind === 'aop_dept'), salesDone, prevDone,
      cycle.settings.cdStep ? cycle.cdStatus === 'with_cd' || cycle.cdStatus === 'submitted' : cycle.dept !== null];
  const n = done.filter(Boolean).length;
  // Steps not done yet, named for the admin before sending to the CD.
  const colsDone = org.depts.length > 0 && org.depts.every((d) => d.channels.length > 0);
  const missing = ka ? [] : [
    ...(!ntDone ? [tc('step2', { period })] : []),
    ...(!done[2] ? [`${tc('tabFiles')} › ${tc('step3')}`] : []),
    ...(!salesDone ? [`${tc('tabFiles')} › ${tc('step5')} (${cycle.settings.avgMonths.filter((m) => !has(status, 'sales', m)).join(', ')})`] : []),
    ...(!prevDone ? [`${tc('tabFiles')} › ${tc('stepPrevDept')}`] : []),
    ...(!colsDone ? [tc('dcTitle')] : []),
  ];

  async function setMode(m: NtUpload['mode'] | 'ops') {
    setModeBusy(true);
    try {
      await api('PUT', `/api/admin/cycle/${ws}/${period}/settings`, { ntMode: m });
      reload();
    } finally {
      setModeBusy(false);
    }
  }
  const loadedText = nt ? tc('ntLoaded', {
    file: nt.file ?? '', n: Object.keys(nt.byPack).length,
    how: nt.mode === 'dept' ? tc('ntSplitDept', { n: Object.keys(nt.byChannel ?? {}).length }) : nt.mode === 'leaf' ? tc('ntSplitLeaf', { n: Object.keys(nt.byLeaf ?? {}).length }) : nt.mode === 'aop' ? tc('ntModeAop') : tc('ntModePack'),
    cats: CATEGORIES.map((c) => `${c} ${fmtNum(sumCat(nt.byPack, cats, c))}`).join(' · '),
  }) : null;
  const modes: { id: NtUpload['mode'] | 'ops'; label: string }[] = ka
    ? [{ id: 'ops', label: tc('ntModeOps') }, { id: 'aop', label: tc('ntModeAop') }, { id: 'pack', label: tc('ntModePack') }, { id: 'leaf', label: tc('ntModeLeaf') }]
    : [{ id: 'aop', label: tc('ntModeAop') }, { id: 'pack', label: tc('ntModePack') }, { id: 'dept', label: tc('ntModeDept') }];
  const modePicker = (
    <>
      <div class="toolbar" role="radiogroup" aria-label={tc('ntMode')} data-testid="nt-modes">
        {modes.map((m) => (
          <label key={m.id}><input type="radio" name="ntmode" checked={mode === m.id} disabled={locked || modeBusy} onChange={() => void setMode(m.id)} /> <b>{m.label}</b></label>
        ))}
      </div>
      {mode === 'aop' && !ka && (
        <div class="cy-aop-by" data-testid="aop-by">
          <p class="small"><b>{tc('aopByTitle')}</b> <span class="muted">{tc('aopByHelp')}</span></p>
          <div class="toolbar" role="radiogroup" aria-label={tc('aopByTitle')}>
            {(['pack', 'dept'] as const).map((b) => (
              <label key={b} class="small"><input type="radio" name="aop-by" data-testid={`aop-by-${b}`} checked={(cycle.settings.aopBy ?? 'pack') === b} disabled={modeBusy || locked}
                onChange={() => void (async () => { setModeBusy(true); try { await api('PUT', `/api/admin/cycle/${ws}/${period}/settings`, { aopBy: b }); reload(); } finally { setModeBusy(false); } })()} />
                {' '}{b === 'pack' ? tc('aopByPack') : tc('aopByDept')}</label>
            ))}
          </div>
        </div>
      )}
    </>
  );
  const of = done.length;
  // Uploaded files › AOP: upload it by pack, or by pack and department.
  const [aopUp, setAopUp] = useState<'pack' | 'dept'>(cycle.settings.aopBy === 'dept' ? 'dept' : 'pack');
  const aopChoice = (
    <div class="toolbar" role="radiogroup" aria-label={tc('aopUpTitle')} data-testid="aop-upload-by">
      <b class="small">{tc('aopUpTitle')}</b>
      {(['pack', 'dept'] as const).map((b) => (
        <label key={b} class="small"><input type="radio" name="aop-up" data-testid={`aop-up-${b}`} checked={aopUp === b} onChange={() => setAopUp(b)} /> {b === 'pack' ? tc('aopByPack') : tc('aopByDept')}</label>
      ))}
    </div>
  );

  return (
    <PacksAdded.Provider value={reload}>
    <PacksVersion.Provider value={org.packs.length}>
    <>
      <div class="cy-progress" aria-label={tc('stepsDone', { n, of })}>
        <div class="bar"><span style={{ width: `${(n / of) * 100}%` }} /></div>
        <b>{tc('stepsDone', { n, of })}</b>
      </div>
      {part === 'start' && exists && (
        <div class="toolbar cy-revert">
          <span class="muted small">{tc('revertHelp', { period })}</span>
          <span class="spacer" />
          <ConfirmButton testId="revert" label={tc('revertBtn')} question={tc('revertQ', { period })} yesLabel={tc('revertBtn')} onConfirm={async () => {
            await api('POST', `/api/admin/cycle/${ws}/${period}/revert`, {});
            clearRouteCache();
            setRevertMsg(tc('revertDone', { period }));
            reload();
            ntData.reload();
          }} />
        </div>
      )}
      {revertMsg && <div class="banner ok" role="status" data-testid="revert-done">{revertMsg}</div>}
      {part === 'start' && <SettingsStep ws={ws} period={period} cycle={cycle} exists={exists} onSaved={reload} />}
      {part === 'start' && exists && (
        <>
          {!ka && <DeptColumnsStep org={org} onSaved={reload} />}
          {mode === 'ops' && ka && <KaFromOpsStep period={period} l={l} modePicker={modePicker} onChanged={reload} />}
          {mode === 'aop' && (ka || (cycle.settings.aopBy ?? 'pack') === 'pack') && <AopTargetStep ws={ws} period={period} org={org} saved={nt} locked={locked} modePicker={modePicker} onSaved={(m) => after(m)} onPacksChanged={reload} />}
          {mode === 'aop' && !ka && cycle.settings.aopBy === 'dept' && (
            <AopDeptStep ws={ws} period={period} org={org} saved={nt} modePicker={modePicker} onSaved={(m) => { after(m); ntData.reload(); }} />
          )}
          {mode === 'pack' && (
            <UploadStep ws={ws} clearKind={{ table: 'months', kind: 'new_target' }} n={2} title={tc('step2', { period })} help={tc('step2aHelp')} template={() => T.newTargetByPack(org, period)} done={done[1]!} locked={locked} loaded={loadedText}
              parse={({ rows }) => {
                const r = parseNewTargetByPack(rows!, period, idx);
                return { checks: r.checks, summary: tc('sumPacks', { n: Object.keys(r.byPack).length, total: fmtNum(total(r.byPack)) }), payload: r.byPack };
              }}
              upload={async (byPack, file) => after(tc('savedMonths', { n: await uploadMonths(ws, 'new_target', { [period]: { mode: 'pack', byPack, file } }) }))}>
              {modePicker}
            </UploadStep>
          )}
          {mode === 'dept' && !ka && (
            <UploadStep ws={ws} clearKind={{ table: 'months', kind: 'new_target' }} n={2} title={tc('step2', { period })} help={tc('step2bHelp')} template={() => T.newTargetByDept(org, period)} done={done[1]!} locked={locked} loaded={loadedText}
              parse={({ rows }) => {
                const r = parseChannelGrid(rows!, channels, idx, groups);
                const byPack: Grid = {};
                for (const g of Object.values(r.byChannel)) for (const [p, v] of Object.entries(g)) byPack[p] = (byPack[p] ?? 0) + v;
                return { checks: r.checks, summary: tc('sumPacks', { n: Object.keys(byPack).length, total: fmtNum(total(byPack)) }), payload: { mode: 'dept', byPack, byChannel: r.byChannel } };
              }}
              upload={async (payload, file) => {
                const n = await uploadMonths(ws, 'new_target', { [period]: { ...(payload as object), file } });
                // Uploaded by department: it is the department target right away (no CD).
                const byChannel = (payload as { byChannel: Record<string, Grid> }).byChannel;
                const dept: Record<string, Grid> = {};
                for (const d of org.depts) {
                  const t: Grid = {};
                  for (const c of d.channels) for (const [p, v] of Object.entries(byChannel[c.channel] ?? {})) t[p] = (t[p] ?? 0) + v;
                  dept[String(d.id)] = t;
                }
                await api('PUT', `/api/admin/cycle/${ws}/${period}/dept-target`, { dept }).catch(() => undefined);
                return after(tc('savedMonths', { n }));
              }}>
              {modePicker}
            </UploadStep>
          )}
          {(mode === 'dept' || (mode === 'aop' && cycle.settings.aopBy === 'dept')) && !ka && nt?.mode === 'dept' && nt.byChannel && (
            <DeptUploadTable key={`${cycle.version}`} ws={ws} period={period} org={org} nt={nt} cdStep={cycle.settings.cdStep} onSaved={(m) => { after(m); ntData.reload(); }} />
          )}
          {mode === 'leaf' && ka && (
            <UploadStep ws={ws} clearKind={{ table: 'months', kind: 'new_target' }} n={2} title={tc('step2', { period })} help={tc('step2cHelp')} template={() => T.newTargetByLeaf(org, period)} done={done[1]!} locked={locked} loaded={loadedText}
              parse={({ rows }) => {
                const r = parseNewTargetByLeaf(rows!, period, idx, routes);
                return { checks: r.checks, summary: tc('sumPacks', { n: Object.keys(r.byPack).length, total: fmtNum(total(r.byPack)) }), payload: { mode: 'leaf', byPack: r.byPack, byLeaf: r.byLeaf, byKam: r.byKam } };
              }}
              upload={async (payload, file) => after(tc('savedMonths', { n: await uploadMonths(ws, 'new_target', { [period]: { ...(payload as object), file } }) }))}>
              {modePicker}
            </UploadStep>
          )}
          {((ka && mode === 'dept') || (!ka && (mode === 'leaf' || mode === 'ops'))) && (
            <div class="cy-step" data-testid="step-2"><div class="cy-step-head"><span class="cy-step-n">2</span><div><b>{tc('step2', { period })}</b></div></div>{modePicker}</div>
          )}
        </>
      )}
      {part === 'files' && (
        <>
          <p class="muted small">{tc('filesHelp')}</p>
          {!ka && aopUp === 'dept' && <AopDeptUpload ws={ws} period={period} org={org} n={1}>{aopChoice}</AopDeptUpload>}
          {!ka && aopUp === 'pack' && (
            <UploadStep ws={ws} clearKind={{ table: 'months', kind: 'aop' }} n={1} title={tc('step3')} help={tc('step3Help')} template={() => T.aop(org, period)} done={done[2]!} locked={locked} multiSheet
              parse={({ sheets }) => {
                const r = parseAop(sheets!, idx);
                return { checks: r.checks, summary: tc('sumMonths', { n: Object.keys(r.byMonth).length }), payload: r.byMonth };
              }}
              upload={async (p) => after(tc('savedMonths', { n: await uploadMonths(ws, 'aop', p as Record<string, unknown>) }))}>
              {aopChoice}
            </UploadStep>
          )}
          <UploadStep ws={ws} clearKind={{ table: 'routes', kind: 'sales' }} n={ka ? 1 : 2} title={ka ? tc('step5Ka') : tc('step5')} help={ka ? tc('step5HelpKa') : tc('step5Help')}
            template={() => (ka ? T.kaSales(org, period) : T.sales(org, period, ws))} done={salesDone} locked={false}
            parse={({ rows }) => {
              const r = parseSales(rows!, idx, routes);
              return { checks: r.checks, summary: tc('sumMonths', { n: Object.keys(r.data).length }), payload: r.data };
            }}
            upload={async (p, file, prog) => after(tc('savedRows', { n: fmtNum(await uploadRoutes(ws, 'sales', p as RouteMonthData, null, file, prog)) }))} />
          {ka ? (
            <UploadStep ws={ws} clearKind={{ table: 'routes', kind: 'prev_target' }} n={2} title={tc('stepPrevKa')} help={tc('stepPrevKaHelp')} template={() => T.kaPrevTargets(org, period)} done={prevDone} locked={false}
              loaded={prevLoaded(status, 'prev_target')}
              parse={({ rows }) => {
                const r = parsePrevTargets(rows!, idx);
                return { checks: r.checks, summary: tc('sumMonths', { n: Object.keys(r.data).length }), payload: r };
              }}
              upload={async (p, file, prog) => {
                const r = p as { data: RouteMonthData; extra: Record<string, Record<string, Record<string, unknown>>> };
                return after(tc('savedRows', { n: fmtNum(await uploadRoutes(ws, 'prev_target', r.data, r.extra, file, prog)) }));
              }}>
              <KaNote period={period} cycle={cycle} onSaved={reload} />
            </UploadStep>
          ) : (
            <UploadStep ws={ws} clearKind={{ table: 'months', kind: 'dept_channel' }} n={3} title={tc('stepPrevDept')} help={tc('stepPrevDeptHelp')} template={() => T.deptChannelTargets(org, period)} done={prevDone} locked={false} multiSheet
              loaded={prevLoaded(status, 'dept_channel')}
              parse={({ sheets }) => {
                const byMonth: Record<string, Record<string, Grid>> = {};
                const checks: Check[] = [];
                for (const sh of sheets!) {
                  const m = sheetMonth(sh);
                  if (!m) { checks.push({ level: 'warning', text: tc('sheetNoMonth', { sheet: sh.sheet }) }); continue; }
                  const r = parseChannelGrid(sh.data, channels, idx, groups);
                  const errs = r.checks.filter((c) => c.level === 'error');
                  if (errs.length) { checks.push(...errs.map((c) => ({ level: 'warning' as const, text: `${sh.sheet}: ${c.text}` }))); continue; }
                  byMonth[m] = r.byChannel;
                  for (const c of r.checks) if (c.level === 'warning') checks.push({ level: 'info', text: `${sh.sheet}: ${c.text}` });
                }
                if (!Object.keys(byMonth).length) checks.push({ level: 'error', text: tc('noMonthsRead') });
                const months = Object.keys(byMonth).sort();
                return { checks, summary: tc('prevDeptSummary', { n: months.length, from: months[0] ?? '-', to: months[months.length - 1] ?? '-' }), payload: byMonth };
              }}
              upload={async (p) => after(tc('savedMonths', { n: await uploadMonths(ws, 'dept_channel', p as Record<string, unknown>) }))} />
          )}
        </>
      )}
      {part === 'start' && exists && !ka && <SendStep ws={ws} period={period} l={l} onDone={reload} missing={missing} />}
    </>
    </PacksVersion.Provider>
    </PacksAdded.Provider>
  );
}

/** "Loaded: 2025-01 to 2026-10 (22 months)" for a kind of upload. */
function prevLoaded(status: DataStatus, kind: string): string | null {
  const months = [...new Set(status.filter((s) => s.kind === kind).map((s) => s.month))].sort();
  return months.length ? tc('loadedMonths', { from: months[0]!, to: months[months.length - 1]!, n: months.length }) : null;
}

// ---------- tab: control ----------

type SendResult = { monthId: number; ka?: { deptId: number; name: string; sent: boolean; reason?: string }[] };

/** "Key Account sent with it: X · Not sent: Y (reason)" after an Operation send. */
function kaNoteOf(results: SendResult[]): string | null {
  const ka = results.flatMap((r) => r.ka ?? []);
  if (!ka.length) return null;
  const sent = ka.filter((k) => k.sent).map((k) => k.name);
  const not = ka.filter((k) => !k.sent).map((k) => `${k.name} (${k.reason ?? ''})`);
  return [sent.length ? tc('kaSentWith', { names: sent.join(', ') }) : '', not.length ? tc('kaNotSent', { names: not.join(' · ') }) : '']
    .filter(Boolean).join(' ');
}

function ControlTab({ ws, period, l, reload }: { ws: Workspace; period: string; l: Loaded; reload: () => void }) {
  const [lang] = useLang();
  const { cycle } = l;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [kaNote, setKaNote] = useState<string | null>(null);
  const isKa = ws === 'ka';

  async function send(deptId: number) {
    setBusy(deptId);
    setErr(null);
    try {
      const r = await api<SendResult>('POST', `/api/admin/cycle/${ws}/${period}/heads/${deptId}/send`, {});
      setKaNote(kaNoteOf([r]));
      reload();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(null);
    }
  }
  async function restart(deptId: number) {
    setErr(null);
    try {
      await api('POST', `/api/admin/cycle/${ws}/${period}/heads/${deptId}/restart`, {});
      reload();
    } catch (x) {
      setErr(errText(x));
    }
  }
  const ready = cycle.settings.cdStep ? cycle.cdStatus === 'submitted' : cycle.dept !== null;
  const sendable = cycle.heads.filter((h) => ready && cycle.calcDepts.includes(String(h.deptId)) && (h.status === 'draft' || h.status === 'returned'));
  const [picked, setPicked] = useState<Set<number>>(new Set());
  async function sendMany(ids: number[]) {
    setErr(null);
    const failed: string[] = [];
    const results: SendResult[] = [];
    for (const id of ids) {
      setBusy(id);
      try {
        results.push(await api<SendResult>('POST', `/api/admin/cycle/${ws}/${period}/heads/${id}/send`, {}));
      } catch (x) {
        failed.push(`${cycle.heads.find((h) => h.deptId === id)?.name ?? id}: ${errText(x)}`);
      }
    }
    setBusy(null);
    setPicked(new Set());
    setKaNote(kaNoteOf(results));
    if (failed.length) setErr(failed.join(' · '));
    reload();
  }
  return (
    <Section title={tc('controlTitle')} right={
      <div class="toolbar">
        {!isKa && picked.size > 0 && <button type="button" class="btn" disabled={busy !== null} onClick={() => void sendMany([...picked])}>{tc('sendSelected', { n: picked.size })}</button>}
        {!isKa && <button type="button" class="btn primary" data-testid="send-all" disabled={busy !== null || sendable.length === 0} onClick={() => void sendMany(sendable.map((h) => h.deptId))}>{tc('sendToAll', { n: sendable.length })}</button>}
        {cycle.monthId ? <a class="btn" href={`/admin/months/${cycle.monthId}`}>{tc('openBoard')}</a> : null}
      </div>
    }>
      {isKa && <p class="banner" data-testid="ka-sends-with-ops">{tc('kaSendsWithOps')}</p>}
      {!isKa && <p class="muted small" data-testid="ops-sends-ka">{tc('opsSendsKa')}</p>}
      {!ready && <p class="muted">{tc('controlNotReady')}</p>}
      {kaNote && <div class="banner" role="status" data-testid="ka-send-note">{kaNote}</div>}
      {err && <div class="alert" role="alert">{err}</div>}
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr>
          <th><span class="visually-hidden">{tc('select')}</span></th>
          <th>{tc('head')}</th><th>{tc('status')}</th><th class="num">{tc('sentTotal')}</th><th>{tc('sentAt')}</th><th>{tc('progress')}</th><th>{tc('comment')}</th><th />
        </tr></thead>
        <tbody>{cycle.heads.map((h) => {
          const pr = cycle.progress[String(h.deptId)];
          const canSend = ready && cycle.calcDepts.includes(String(h.deptId)) && (h.status === 'draft' || h.status === 'returned');
          return (
            <tr key={h.deptId} data-testid="head-row">
              <td>{canSend && !isKa && <input type="checkbox" aria-label={`${tc('select')} ${h.name}`} checked={picked.has(h.deptId)}
                onChange={(e) => { const next = new Set(picked); if (e.currentTarget.checked) next.add(h.deptId); else next.delete(h.deptId); setPicked(next); }} />}</td>
              <td><b>{h.name}</b><div class="muted small">{h.headName ?? tc('noHeadUser')}</div></td>
              <td><span class={`pill ${h.status}`}>{tc(`hs_${h.status}` as 'hs_draft')}</span>{h.monthState === 'complete' && <span class="pill ok">{tc('final')}</span>}</td>
              <td class="num">{fmtCases(h.sentTotal)}</td>
              <td class="small">{fmtDateTime(h.sentAt, lang)}</td>
              <td class="small">{pr ? tc('progressText', { s: pr.submitted, o: pr.in_progress, w: pr.waiting }) : '—'}</td>
              <td class="small">{h.comment ?? ''}</td>
              <td class="act">
                {canSend && <button type="button" class={isKa ? 'btn' : 'btn primary'} disabled={busy === h.deptId} onClick={() => void send(h.deptId)}>{tc(isKa ? 'sendKaLate' : 'sendToHead')}</button>}
                {h.status === 'pending' && <ConfirmButton label={tc('recall')} question={tc('recallHeadQ')} yesLabel={tc('recall')} onConfirm={() => restart(h.deptId)} />}
                {(h.status === 'approved' || h.status === 'returned') && <ConfirmButton label={tc('restart')} question={tc('restartQ')} yesLabel={tc('restart')} onConfirm={() => restart(h.deptId)} />}
              </td>
            </tr>
          );
        })}</tbody>
      </table></div>
      <p class="muted small">{tc('controlHelp')}</p>
    </Section>
  );
}

// ---------- tab: route targets and variance ----------

function RoutesTab({ ws, period, l }: { ws: Workspace; period: string; l: Loaded }) {
  useLang();
  const { cycle, org } = l;
  const data = useAsync(cycle.monthId ? async () => {
    const [exp, calc] = await Promise.all([
      api<ExportResult>('GET', `/api/admin/months/${cycle.monthId}/export?dept=all`),
      api<Record<string, Record<string, Grid>>>('GET', `/api/cycle/${ws}/${period}/calc`),
    ]);
    return { exp, calc };
  } : null, [cycle.monthId, ws, period]);
  if (!cycle.monthId) return <p class="card muted">{tc('noMonthYet')}</p>;
  if (data.error) return <div class="alert">{data.error}</div>;
  if (!data.data) return <p class="muted">{tc('loading')}</p>;
  const { exp, calc } = data.data;
  const wsRoutes = new Set(org.leaves.map((x) => x.routeCode));
  const rows = exp.rows.filter((r) => wsRoutes.has(String(r[2])));
  const allFinal = cycle.heads.length > 0 && cycle.heads.every((h) => h.monthState === 'complete');
  function exportFinal() {
    const byId = new Map(org.nodes.map((n) => [n.id, n]));
    const leafOf = new Map(org.leaves.map((x) => [x.routeCode, x]));
    const cats = catMap(org);
    const subOf = subMap(org.packs);
    const pathOf = (route: string) => {
      const leaf = leafOf.get(route);
      const path: string[] = [];
      for (let n = leaf ? byId.get(leaf.nodeId) : undefined; n; n = n.parentId === null ? undefined : byId.get(n.parentId)) path.unshift(n.name);
      return path;
    };
    const list = rows.filter((r) => Number(r[5]) !== 0).map((r) => {
      const [h = '', m = '', s = ''] = pathOf(String(r[2]));
      return [String(r[0]).replace('-', ''), String(r[1]), String(r[2]), String(r[3]), String(r[4]), Number(r[5]), 'Cases', h, m, s, cats.get(String(r[4])) ?? '', subOf(String(r[4]))];
    });
    void writeWorkbook(`new_target_${ws}_${period}.xlsx`, [{
      name: 'New target',
      columns: ['Period', 'Delivery System', 'Route Code', 'Salesman ID', 'Sales Target Category', 'Cases', 'Format', 'Head of Department', 'Manager', 'Supervisor', 'Category', 'Sub category'],
      rows: list,
    }]);
  }
  const finalBy = new Map<string, number>();
  for (const r of rows) finalBy.set(`${r[2]}|${r[4]}`, Number(r[5]));
  const variance: { route: string; pack: string; sent: number; final: number }[] = [];
  for (const routes of Object.values(calc)) for (const [r, g] of Object.entries(routes)) {
    const packs = new Set([...Object.keys(g), ...rows.filter((x) => x[2] === r).map((x) => String(x[4]))]);
    for (const p of packs) {
      const sent = g[p] ?? 0;
      const fin = finalBy.get(`${r}|${p}`);
      if (fin !== undefined && fin !== sent) variance.push({ route: r, pack: p, sent, final: fin });
    }
  }
  return (
    <>
      <Section title={tc('routeTargets')} right={
        <div class="toolbar">
          <button type="button" class="btn primary" data-testid="export-final" onClick={() => exportFinal()}>{tc('exportFinal')}</button>
          <button type="button" class="btn" onClick={() => downloadCsv(`route_targets_${ws}_${period}.csv`, [...exp.columns, 'Format'], rows.map((r) => [...r, 'Cases']))}>{tc('downloadCsv')}</button>
        </div>
      }>
        {!allFinal && <p class="banner warn small">{tc('notAllFinal')}</p>}
        <p class="small">{tc('routeTargetsHelp', { n: fmtNum(rows.length) })}</p>
      </Section>
      <FinalSummary ws={ws} period={period} org={org} calc={calc} rows={rows} />
      <Section title={tc('varianceTitle')}>
        {variance.length === 0 ? <p class="muted">{tc('noVariance')}</p> : (
          <div class="tablewrap"><table class="ad-table cy-table">
            <thead><tr><th>{tc('route')}</th><th>{tc('pack')}</th><th class="num">{tc('sent')}</th><th class="num">{tc('finalCol')}</th><th class="num">{tc('diff')}</th></tr></thead>
            <tbody>{variance.slice(0, 500).map((v, i) => (
              <tr key={i}><td><bdi>{v.route}</bdi></td><td><bdi>{v.pack}</bdi></td><td class="num">{fmtNum(v.sent)}</td><td class="num">{fmtNum(v.final)}</td><td class="num">{fmtNum(v.final - v.sent)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Section>
    </>
  );
}

// ---------- final target: uploaded by the admin vs set by the users ----------

type Lvl = 'head' | 'manager' | 'supervisor' | 'route';

/** Per Head, manager, supervisor and route: the target the admin sent (uploaded), the target the users set, and the variance. */
function FinalSummary({ ws, period, org, calc, rows }: { ws: Workspace; period: string; org: OrgDto; calc: Record<string, Record<string, Grid>>; rows: (string | number)[][] }) {
  useLang();
  const [lvl, setLvl] = useState<Lvl>('head');
  const byId = new Map(org.nodes.map((n) => [n.id, n]));
  const depthOf = (id: number) => { let d = 0; for (let p = byId.get(id)?.parentId ?? null; p !== null; p = byId.get(p)?.parentId ?? null) d++; return d; };
  const up = new Map<string, number>();
  for (const routes of Object.values(calc)) for (const [r, g] of Object.entries(routes)) up.set(r, (up.get(r) ?? 0) + total(g));
  const set = new Map<string, number>();
  for (const r of rows) set.set(String(r[2]), (set.get(String(r[2])) ?? 0) + Number(r[5]));
  const nodeUp = new Map<number, number>();
  const nodeSet = new Map<number, number>();
  const leaves = org.leaves.filter((x) => up.has(x.routeCode) || set.has(x.routeCode));
  for (const leaf of leaves) {
    for (let n = byId.get(leaf.nodeId); n; n = n.parentId === null ? undefined : byId.get(n.parentId)) {
      nodeUp.set(n.id, (nodeUp.get(n.id) ?? 0) + (up.get(leaf.routeCode) ?? 0));
      nodeSet.set(n.id, (nodeSet.get(n.id) ?? 0) + (set.get(leaf.routeCode) ?? 0));
    }
  }
  const lvOf = (d: number): Lvl => (d === 0 ? 'head' : d === 1 ? 'manager' : 'supervisor');
  const pathName = (id: number) => { const out: string[] = []; for (let n = byId.get(id); n; n = n.parentId === null ? undefined : byId.get(n.parentId)) out.unshift(n.name); return out; };
  type Row = { key: string; name: string; under: string; up: number; set: number };
  const list: Row[] = lvl === 'route'
    ? leaves.map((x) => ({ key: x.routeCode, name: x.label && x.label !== x.routeCode ? `${x.routeCode} · ${x.label}` : x.routeCode, under: pathName(x.nodeId).join(' › '), up: up.get(x.routeCode) ?? 0, set: set.get(x.routeCode) ?? 0 }))
    : org.nodes.filter((n) => nodeUp.has(n.id) && lvOf(Math.min(depthOf(n.id), 2)) === lvl && (lvl !== 'supervisor' || depthOf(n.id) >= 2))
      .map((n) => ({ key: String(n.id), name: n.name, under: pathName(n.id).slice(0, -1).join(' › '), up: nodeUp.get(n.id) ?? 0, set: nodeSet.get(n.id) ?? 0 }));
  list.sort((a, b) => a.under.localeCompare(b.under) || a.name.localeCompare(b.name));
  const tot = list.reduce((acc, r) => ({ up: acc.up + r.up, set: acc.set + r.set }), { up: 0, set: 0 });
  const pct = (a: number, b: number) => (a ? `${(((b - a) / a) * 100).toFixed(1)}%` : '—');
  const label: Record<Lvl, string> = { head: tc('lvHead'), manager: ws === 'ka' ? 'KAM' : tc('lvManager'), supervisor: tc('lvSupervisor'), route: tc('route') };
  const levels: Lvl[] = ws === 'ka' ? ['head', 'manager', 'route'] : ['head', 'manager', 'supervisor', 'route'];
  return (
    <Section title={tc('fsTitle')} right={
      <div class="toolbar">
        <Tabs<Lvl> value={lvl} onChange={setLvl} items={levels.map((x) => ({ id: x, label: label[x] }))} />
        <button type="button" class="btn" onClick={() => downloadCsv(`target_summary_${lvl}_${ws}_${period}.csv`, [label[lvl], tc('fsUnder'), tc('fsUploaded'), tc('fsSet'), tc('diff'), '%'],
          list.map((r) => [r.name, r.under, r.up, r.set, r.set - r.up, pct(r.up, r.set)]))}>{tc('downloadCsv')}</button>
      </div>
    }>
      <p class="small muted">{tc('fsHelp')}</p>
      <div class="tablewrap cy-tall"><table class="ad-table cy-table" data-testid="final-summary">
        <thead><tr><th>{label[lvl]}</th><th>{tc('fsUnder')}</th><th class="num">{tc('fsUploaded')}</th><th class="num">{tc('fsSet')}</th><th class="num">{tc('diff')}</th><th class="num">%</th></tr></thead>
        <tbody>{list.map((r) => (
          <tr key={r.key}>
            <td><bdi>{r.name}</bdi></td><td class="small muted">{r.under}</td>
            <td class="num">{fmtNum(r.up)}</td><td class="num">{fmtNum(r.set)}</td>
            <td class={`num${r.set - r.up ? ' warn' : ''}`}>{fmtNum(r.set - r.up)}</td><td class="num small">{pct(r.up, r.set)}</td>
          </tr>
        ))}</tbody>
        <tfoot><tr class="sub l1"><td>{tc('total')}</td><td /><td class="num">{fmtNum(tot.up)}</td><td class="num">{fmtNum(tot.set)}</td><td class="num">{fmtNum(tot.set - tot.up)}</td><td class="num small">{pct(tot.up, tot.set)}</td></tr></tfoot>
      </table></div>
    </Section>
  );
}

// ---------- page ----------

export function AdminCycle({ ws: wsParam, period: periodParam }: { ws?: string; period?: string }) {
  useLang();
  const { route, query } = useLocation();
  const ws: Workspace = wsParam === 'ka' ? 'ka' : 'ops';
  const period = periodParam && /^\d{4}-\d{2}$/.test(periodParam) ? periodParam : defaultPeriod();
  // The tab lives in the address (?tab=), so changing the month or reloading keeps it.
  const TAB_IDS: TabId[] = ['files', 'start', 'calc', 'control', 'workflow', 'routes'];
  const tab: TabId = TAB_IDS.includes(query.tab as TabId) ? (query.tab as TabId) : 'start';
  const go = (w: Workspace, p: string, t: TabId) => route(`/admin/cycle/${w}/${p}${t === 'start' ? '' : `?tab=${t}`}`, true);
  const setTab = (t: TabId) => go(ws, period, t);
  const loaded = useAsync<Loaded>(async () => {
    const [cycle, org, st] = await Promise.all([getCycle(ws, period), getOrg(ws), api<{ status: DataStatus }>('GET', `/api/data/${ws}/status`)]);
    if (ws !== 'ka') {
      // Operation: the Key Account target of the linked Heads is calculated before the send to the Heads.
      const [ka, links] = await Promise.all([getCycle('ka', period).catch(() => undefined), api<{ links: KaLink[] }>('GET', '/api/admin/ka-links').catch(() => ({ links: [] as KaLink[] }))]);
      return { cycle, org, status: st.status, ka, links: links.links };
    }
    // Key Accounts build on the Operation target of the linked departments.
    const [ops, links] = await Promise.all([getCycle('ops', period), api<{ links: KaLink[] }>('GET', '/api/admin/ka-links')]);
    return { cycle, org, status: st.status, ops, links: links.links };
  }, [ws, period]);
  const l = loaded.data;
  return (
    <section class="cycle" data-testid="admin-cycle">
      <PageHead title={tc('cycleTitle')} intro={tc('cycleIntro')} />
      <WsPeriod ws={ws} period={period} onChange={(w, p) => go(w, p, tab)} />
      <Tabs<TabId> value={tab} onChange={setTab} items={[
        { id: 'files', label: tc('tabFiles') }, { id: 'start', label: tc('tabStart') }, { id: 'calc', label: tc('tabCalc') }, { id: 'control', label: tc('tabControl') },
        { id: 'workflow', label: tc('tabWorkflow') }, { id: 'routes', label: tc('tabRoutes') },
      ]} />
      {loaded.error && <div class="alert" role="alert">{loaded.error} <button type="button" class="btn" onClick={loaded.reload}>{tc('retry')}</button></div>}
      {(!l || l.cycle.period !== period || l.cycle.ws !== ws) && !loaded.error && <p class="muted">{tc('loading')}</p>}
      {l && l.org.depts.length === 0 && <div class="banner warn">{tc('noDepts')} <a href="/admin/departments">{tc('openDepts')}</a></div>}
      {l && l.cycle.period === period && l.cycle.ws === ws && <NextStep ws={ws} period={period} l={l} tab={tab} onGo={setTab} />}
      {l && l.cycle.period === period && l.cycle.ws === ws && <div key={`${ws}/${period}`} class="cy-tabbody">
      {(tab === 'start' || tab === 'files') && <StartTab key={tab} ws={ws} period={period} l={l} reload={loaded.reload} part={tab} />}
      {tab === 'calc' && (ws === 'ka'
        ? <KaCalcTab period={period} l={l} reload={loaded.reload} onNext={() => setTab('control')} />
        : <CalcTab ws={ws} period={period} l={l} reload={loaded.reload} onNext={() => setTab('control')} />)}
      {tab === 'control' && <ControlTab ws={ws} period={period} l={l} reload={loaded.reload} />}
      {tab === 'workflow' && <WorkflowTab ws={ws} period={period} l={l} />}
      {tab === 'routes' && <RoutesTab ws={ws} period={period} l={l} />}
      </div>}
    </section>
  );
}
