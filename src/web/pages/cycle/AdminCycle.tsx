// Admin › Target cycle (handover sections 3, 4, 6, 9): the 5-step start with
// every upload, the Commercial Director hand-off, the target calculator, the
// send / restart control per Head of Department, route targets and variance.
import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { useMemo, useState } from 'preact/hooks';
import { CATEGORIES } from '../../../shared/calc/packs';
import { pago as pagoOf } from '../../../shared/calc/periods';
import { CalcTab } from './AdminCalc';
import { WorkflowTab } from './AdminWorkflow';
import * as T from '../../cycle/templates';
import type { Workspace } from '../../../worker/auth';
import type { CycleDto, CycleSettings } from '../../../worker/services/cycle';
import type { DataStatus, OrgDto } from '../../../worker/services/cycleData';
import type { ExportResult } from '../../../worker/services/export';
import { api } from '../../api';
import { ConfirmButton, errText, PageHead } from '../../components/AdminBits';
import { readSheet, readSheets } from '../../excel';
import { fmtDateTime } from '../../format';
import { fmtNum, useLang } from '../../i18n';
import { catMap, cdRows, startNewTarget, subMap, sumCat, total, type Grid, type NtSource } from '../../cycle/compute';
import { tc } from '../../cycle/i18n';
import { clearRouteCache, getCycle, getOrg, loadMonthData, loadRouteData, useAsync } from '../../cycle/load';
import {
  packIndex, parseAop, parseChannelGrid, parseNewTargetByLeaf, parseNewTargetByPack, parsePackMapping, parseSales,
  type Check, type RouteMonthData,
} from '../../cycle/parsers';
import { Checks, defaultPeriod, downloadCsv, fmtCases, Section, Tabs, writeWorkbook, WsPeriod } from '../../cycle/ui';

type Loaded = { cycle: CycleDto; org: OrgDto; status: DataStatus };
type TabId = 'start' | 'calc' | 'control' | 'workflow' | 'routes';
type NtUpload = { mode: 'pack' | 'dept' | 'leaf'; byPack: Grid; byChannel?: Record<string, Grid>; byLeaf?: Record<string, Grid>; byKam?: Record<string, Grid>; file?: string };

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

async function uploadMonths(ws: Workspace, kind: 'new_target' | 'aop' | 'fy_target' | 'dept_channel', byMonth: Record<string, unknown>): Promise<number> {
  const months = Object.keys(byMonth).sort();
  for (const m of months) await api('POST', `/api/admin/data/${ws}/months`, { kind, month: m, values: byMonth[m] });
  return months.length;
}

function has(status: DataStatus, kind: string, month: string): boolean {
  return status.some((s) => s.kind === kind && s.month === month);
}

/** One upload step: template, file, checks, confirm. */
function UploadStep({ n, title, help, template, done, locked, parse, upload, multiSheet, loaded, children }: {
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

  async function onFile(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!f) return;
    setErr(null);
    setMsg(null);
    try {
      const input = multiSheet ? { sheets: await readSheets(f) } : { rows: await readSheet(f) };
      setParsed({ ...parse(input), file: f.name });
    } catch (x) {
      setErr(`${tc('fileUnreadable')} (${x instanceof Error ? x.message : ''})`);
    }
  }

  async function onUpload() {
    if (!parsed) return;
    setBusy(true);
    setErr(null);
    try {
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
      await api('PUT', `/api/admin/cycle/${ws}/${period}/settings`, { cdStep: s.cdStep, deadlines: s.deadlines, capPct: s.capPct, ntMode: s.ntMode });
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
        <div><b>{tc('step1')}</b><p class="muted small">{tc('step1Help', { period, pago: pagoOf(period), yago: `${Number(period.slice(0, 4)) - 1}${period.slice(4)}` })}</p></div>
        <span class="spacer" />
        {cycle.settings.capPct !== null && exists && <span class="pill ok">{tc('capIs', { n: cycle.settings.capPct })}</span>}
      </div>
      <div class="cy-grid">
        {dl('head', tc('dlHead'))}
        {dl('manager', tc('dlManager'))}
        {dl('supervisor', tc('dlSupervisor'))}
        <label class="field">
          <span>{tc('cdStep')}</span>
          <select value={s.cdStep ? 'on' : 'off'} onChange={(e) => setS({ ...s, cdStep: e.currentTarget.value === 'on' })}>
            <option value="on">{tc('on')}</option>
            <option value="off">{tc('off')}</option>
          </select>
        </label>
        <label class="field">
          <span>{tc('capPct')}</span>
          <input type="number" min={0} max={100} step="0.5" value={s.capPct ?? ''} placeholder={tc('capPlaceholder')} data-testid="cap-pct"
            onInput={(e) => { const v = e.currentTarget.value; setS({ ...s, capPct: v === '' ? null : Math.min(100, Math.max(0, Number(v))) }); }} />
        </label>
      </div>
      <p class="muted small">{tc('capHelp')}</p>
      <div class="actions">
        <button type="button" class="btn primary" disabled={busy} onClick={() => void save()}>{exists ? tc('save') : tc('openCycle')}</button>
      </div>
      {err && <div class="alert" role="alert">{err}</div>}
    </div>
  );
}

// ---------- step 8: send ----------

function SendStep({ ws, period, l, onDone }: { ws: Workspace; period: string; l: Loaded; onDone: () => void }) {
  useLang();
  const { cycle, org } = l;
  const [preview, setPreview] = useState<{ nt: Grid; source: NtSource; upload: NtUpload | null } | null>(null);
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
      setPreview({ ...r, upload: up });
    } catch (x) {
      setErr(errText(x));
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
      setErr(errText(x));
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
  async function fromUpload() {
    setErr(null);
    setBusy(true);
    try {
      const up = (await loadMonthData<NtUpload>(ws, 'new_target'))[period];
      if (!up) throw new Error(tc('noUploadYet'));
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

  const done = cycle.settings.cdStep ? cycle.cdStatus === 'with_cd' || cycle.cdStatus === 'submitted' : cycle.dept !== null;
  const srcLabel: Record<NtSource, string> = {
    uploaded: tc('srcUploaded'), fy_target: tc('srcFy'), aop_ratio: tc('srcAop'), pago_target: tc('srcPago'), avg_sales: tc('srcAvg'), none: tc('srcNone'),
  };
  // The table shown before sending: every pack with the CD workbook subtotals (and the department split when uploaded by department).
  const deptCols = preview?.upload?.mode === 'dept' && preview.upload.byChannel
    ? org.depts.map((d) => ({ id: d.id, name: d.name, g: d.channels.reduce<Grid>((acc, c) => { for (const [p, n] of Object.entries(preview.upload!.byChannel![c.channel] ?? {})) acc[p] = (acc[p] ?? 0) + n; return acc; }, {}) }))
    : [];
  return (
    <div class={`cy-step${done ? ' done' : ''}`} data-testid="step-5">
      <div class="cy-step-head">
        <span class="cy-step-n">{done ? '✓' : 5}</span>
        <div><b>{tc('step8')}</b><p class="muted small">{cycle.settings.cdStep ? tc('step8HelpCd') : tc('step8HelpNoCd')}</p></div>
      </div>
      {cycle.cdStatus === 'returned' && cycle.cdComment && <div class="banner warn">{tc('cdReturnedWith')} <q>{cycle.cdComment}</q></div>}
      {cycle.settings.cdStep ? (
        <div class="cy-step-body">
          <p>{tc('cdStatus')}: <b data-testid="cd-status">{tc(`cd_${cycle.cdStatus}` as 'cd_draft')}</b></p>
          {(cycle.cdStatus === 'draft' || cycle.cdStatus === 'returned') && !preview && (
            <button type="button" class="btn" disabled={busy} onClick={() => void prepare()}>{tc('prepareNt')}</button>
          )}
          {preview && (
            <>
              <p>{tc('ntSource')}: <b>{srcLabel[preview.source]}</b> · {tc('ntTotal')}: <b>{fmtNum(total(preview.nt))}</b>
                {' · '}{CATEGORIES.map((c) => `${c} ${fmtNum(sumCat(preview.nt, cats, c))}`).join(' · ')}</p>
              <div class="tablewrap cy-tall"><table class="ad-table cy-table" data-testid="nt-preview">
                <thead><tr><th>{tc('pack')}</th><th>{tc('subCategory')}</th>{deptCols.map((d) => <th key={d.id} class="num">{d.name}</th>)}<th class="num">{tc('newTarget')}</th></tr></thead>
                <tbody>{cdRows(Object.keys(preview.nt), cats).map((r) => {
                  const list = r.kind === 'sub' ? r.packs : [r.pack];
                  const sum = (g: Grid) => list.reduce((s, p) => s + (g[p] ?? 0), 0);
                  return (
                    <tr key={r.kind === 'sub' ? r.label : r.pack} class={r.kind === 'sub' ? `sub l${r.level}` : ''}>
                      <td><bdi>{r.kind === 'sub' ? r.label : r.pack}</bdi></td><td class="small muted">{r.kind === 'pack' ? subOf(r.pack) : ''}</td>
                      {deptCols.map((d) => <td key={d.id} class="num">{fmtNum(sum(d.g))}</td>)}
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

// ---------- tab: start ----------

function StartTab({ ws, period, l, reload }: { ws: Workspace; period: string; l: Loaded; reload: () => void }) {
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
  const ntData = useAsync(exists ? () => loadMonthData<NtUpload>(ws, 'new_target') : null, [ws, period, cycle.version, status.length]);
  const nt = ntData.data?.[period] ?? null;
  const mode = cycle.settings.ntMode === 'leaf' && ws !== 'ka' ? 'pack' : cycle.settings.ntMode;
  const done = [
    exists,
    has(status, 'new_target', period),
    status.some((s) => s.kind === 'aop'),
    cycle.settings.avgMonths.every((m) => has(status, 'sales', m)),
    cycle.settings.cdStep ? cycle.cdStatus === 'with_cd' || cycle.cdStatus === 'submitted' : cycle.dept !== null,
  ];
  const n = done.filter(Boolean).length;
  const after = (msg: string) => { reload(); ntData.reload(); return msg; };

  async function setMode(m: 'pack' | 'dept' | 'leaf') {
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
    how: nt.mode === 'dept' ? tc('ntSplitDept', { n: Object.keys(nt.byChannel ?? {}).length }) : nt.mode === 'leaf' ? tc('ntSplitLeaf', { n: Object.keys(nt.byLeaf ?? {}).length }) : tc('ntModePack'),
    cats: CATEGORIES.map((c) => `${c} ${fmtNum(sumCat(nt.byPack, cats, c))}`).join(' · '),
  }) : null;
  const modes: { id: 'pack' | 'dept' | 'leaf'; label: string }[] = ws === 'ka'
    ? [{ id: 'pack', label: tc('ntModePack') }, { id: 'leaf', label: tc('ntModeLeaf') }]
    : [{ id: 'pack', label: tc('ntModePack') }, { id: 'dept', label: tc('ntModeDept') }];
  const modePicker = (
    <div class="toolbar" role="radiogroup" aria-label={tc('ntMode')}>
      {modes.map((m) => (
        <label key={m.id}><input type="radio" name="ntmode" checked={mode === m.id} disabled={locked || modeBusy} onChange={() => void setMode(m.id)} /> <b>{m.label}</b></label>
      ))}
    </div>
  );

  return (
    <>
      <div class="cy-progress" aria-label={tc('stepsDone', { n, of: 5 })}>
        <div class="bar"><span style={{ width: `${(n / 5) * 100}%` }} /></div>
        <b>{tc('stepsDone', { n, of: 5 })}</b>
      </div>
      <SettingsStep ws={ws} period={period} cycle={cycle} exists={exists} onSaved={reload} />
      {exists && (
        <>
          {mode === 'pack' && (
            <UploadStep n={2} title={tc('step2', { period })} help={tc('step2aHelp')} template={() => T.newTargetByPack(org, period)} done={done[1]!} locked={locked} loaded={loadedText}
              parse={({ rows }) => {
                const r = parseNewTargetByPack(rows!, period, idx);
                return { checks: r.checks, summary: tc('sumPacks', { n: Object.keys(r.byPack).length, total: fmtNum(total(r.byPack)) }), payload: r.byPack };
              }}
              upload={async (byPack, file) => after(tc('savedMonths', { n: await uploadMonths(ws, 'new_target', { [period]: { mode: 'pack', byPack, file } }) }))}>
              {modePicker}
            </UploadStep>
          )}
          {mode === 'dept' && (
            <UploadStep n={2} title={tc('step2', { period })} help={tc('step2bHelp')} template={() => T.newTargetByDept(org, period)} done={done[1]!} locked={locked} loaded={loadedText}
              parse={({ rows }) => {
                const r = parseChannelGrid(rows!, channels, idx, groups);
                const byPack: Grid = {};
                for (const g of Object.values(r.byChannel)) for (const [p, v] of Object.entries(g)) byPack[p] = (byPack[p] ?? 0) + v;
                return { checks: r.checks, summary: tc('sumPacks', { n: Object.keys(byPack).length, total: fmtNum(total(byPack)) }), payload: { mode: 'dept', byPack, byChannel: r.byChannel } };
              }}
              upload={async (payload, file) => after(tc('savedMonths', { n: await uploadMonths(ws, 'new_target', { [period]: { ...(payload as object), file } }) }))}>
              {modePicker}
            </UploadStep>
          )}
          {mode === 'leaf' && (
            <UploadStep n={2} title={tc('step2', { period })} help={tc('step2cHelp')} template={() => T.newTargetByLeaf(org, period)} done={done[1]!} locked={locked} loaded={loadedText}
              parse={({ rows }) => {
                const r = parseNewTargetByLeaf(rows!, period, idx, routes);
                return { checks: r.checks, summary: tc('sumPacks', { n: Object.keys(r.byPack).length, total: fmtNum(total(r.byPack)) }), payload: { mode: 'leaf', byPack: r.byPack, byLeaf: r.byLeaf, byKam: r.byKam } };
              }}
              upload={async (payload, file) => after(tc('savedMonths', { n: await uploadMonths(ws, 'new_target', { [period]: { ...(payload as object), file } }) }))}>
              {modePicker}
            </UploadStep>
          )}
          <UploadStep n={3} title={tc('step3')} help={tc('step3Help')} template={() => T.aop(org, period)} done={done[2]!} locked={locked} multiSheet
            parse={({ sheets }) => {
              const r = parseAop(sheets!, idx);
              return { checks: r.checks, summary: tc('sumMonths', { n: Object.keys(r.byMonth).length }), payload: r.byMonth };
            }}
            upload={async (p) => after(tc('savedMonths', { n: await uploadMonths(ws, 'aop', p as Record<string, unknown>) }))} />
          <UploadStep n={4} title={tc('step5')} help={ws === 'ka' ? tc('step5HelpKa') : tc('step5Help')} template={() => T.sales(org, period, ws)} done={done[3]!} locked={false}
            parse={({ rows }) => {
              const r = parseSales(rows!, idx, routes);
              return { checks: r.checks, summary: tc('sumMonths', { n: Object.keys(r.data).length }), payload: r.data };
            }}
            upload={async (p, file, prog) => after(tc('savedRows', { n: fmtNum(await uploadRoutes(ws, 'sales', p as RouteMonthData, null, file, prog)) }))} />
          <UploadStep n={null} title={tc('stepMapping')} help={tc('stepMappingHelp')} template={() => T.packMapping(org)} done={org.packs.some((p) => !!p.sub)} locked={false}
            parse={({ rows }) => {
              const r = parsePackMapping(rows!, idx);
              return { checks: r.checks, summary: tc('sumPacks', { n: Object.keys(r.map).length, total: '—' }), payload: r.map };
            }}
            upload={async (map) => {
              const r = await api<{ updated: number }>('PUT', '/api/admin/packs-sub', { map });
              return after(tc('mappingSaved', { n: r.updated }));
            }} />
          <SendStep ws={ws} period={period} l={l} onDone={reload} />
        </>
      )}
    </>
  );
}

// ---------- tab: control ----------

function ControlTab({ ws, period, l, reload }: { ws: Workspace; period: string; l: Loaded; reload: () => void }) {
  const [lang] = useLang();
  const { cycle } = l;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  async function send(deptId: number) {
    setBusy(deptId);
    setErr(null);
    try {
      await api('POST', `/api/admin/cycle/${ws}/${period}/heads/${deptId}/send`, {});
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
    for (const id of ids) {
      setBusy(id);
      try {
        await api('POST', `/api/admin/cycle/${ws}/${period}/heads/${id}/send`, {});
      } catch (x) {
        failed.push(`${cycle.heads.find((h) => h.deptId === id)?.name ?? id}: ${errText(x)}`);
      }
    }
    setBusy(null);
    setPicked(new Set());
    if (failed.length) setErr(failed.join(' · '));
    reload();
  }
  return (
    <Section title={tc('controlTitle')} right={
      <div class="toolbar">
        {picked.size > 0 && <button type="button" class="btn" disabled={busy !== null} onClick={() => void sendMany([...picked])}>{tc('sendSelected', { n: picked.size })}</button>}
        <button type="button" class="btn primary" data-testid="send-all" disabled={busy !== null || sendable.length === 0} onClick={() => void sendMany(sendable.map((h) => h.deptId))}>{tc('sendToAll', { n: sendable.length })}</button>
        {cycle.monthId ? <a class="btn" href={`/admin/months/${cycle.monthId}`}>{tc('openBoard')}</a> : null}
      </div>
    }>
      {!ready && <p class="muted">{tc('controlNotReady')}</p>}
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
              <td>{canSend && <input type="checkbox" aria-label={`${tc('select')} ${h.name}`} checked={picked.has(h.deptId)}
                onChange={(e) => { const next = new Set(picked); if (e.currentTarget.checked) next.add(h.deptId); else next.delete(h.deptId); setPicked(next); }} />}</td>
              <td><b>{h.name}</b><div class="muted small">{h.headName ?? tc('noHeadUser')}</div></td>
              <td><span class={`pill ${h.status}`}>{tc(`hs_${h.status}` as 'hs_draft')}</span>{h.monthState === 'complete' && <span class="pill ok">{tc('final')}</span>}</td>
              <td class="num">{fmtCases(h.sentTotal)}</td>
              <td class="small">{fmtDateTime(h.sentAt, lang)}</td>
              <td class="small">{pr ? tc('progressText', { s: pr.submitted, o: pr.in_progress, w: pr.waiting }) : '—'}</td>
              <td class="small">{h.comment ?? ''}</td>
              <td class="act">
                {canSend && <button type="button" class="btn primary" disabled={busy === h.deptId} onClick={() => void send(h.deptId)}>{tc('sendToHead')}</button>}
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

// ---------- page ----------

export function AdminCycle({ ws: wsParam, period: periodParam }: { ws?: string; period?: string }) {
  useLang();
  const { route, query } = useLocation();
  const ws: Workspace = wsParam === 'ka' ? 'ka' : 'ops';
  const period = periodParam && /^\d{4}-\d{2}$/.test(periodParam) ? periodParam : defaultPeriod();
  // The tab lives in the address (?tab=), so changing the month or reloading keeps it.
  const TAB_IDS: TabId[] = ['start', 'calc', 'control', 'workflow', 'routes'];
  const tab: TabId = TAB_IDS.includes(query.tab as TabId) ? (query.tab as TabId) : 'start';
  const go = (w: Workspace, p: string, t: TabId) => route(`/admin/cycle/${w}/${p}${t === 'start' ? '' : `?tab=${t}`}`, true);
  const setTab = (t: TabId) => go(ws, period, t);
  const loaded = useAsync<Loaded>(async () => {
    const [cycle, org, st] = await Promise.all([getCycle(ws, period), getOrg(ws), api<{ status: DataStatus }>('GET', `/api/data/${ws}/status`)]);
    return { cycle, org, status: st.status };
  }, [ws, period]);
  const l = loaded.data;
  return (
    <section class="cycle" data-testid="admin-cycle">
      <PageHead title={tc('cycleTitle')} intro={tc('cycleIntro')} />
      <WsPeriod ws={ws} period={period} onChange={(w, p) => go(w, p, tab)} />
      <Tabs<TabId> value={tab} onChange={setTab} items={[
        { id: 'start', label: tc('tabStart') }, { id: 'calc', label: tc('tabCalc') }, { id: 'control', label: tc('tabControl') },
        { id: 'workflow', label: tc('tabWorkflow') }, { id: 'routes', label: tc('tabRoutes') },
      ]} />
      {loaded.error && <div class="alert" role="alert">{loaded.error} <button type="button" class="btn" onClick={loaded.reload}>{tc('retry')}</button></div>}
      {(!l || l.cycle.period !== period || l.cycle.ws !== ws) && !loaded.error && <p class="muted">{tc('loading')}</p>}
      {l && l.org.depts.length === 0 && <div class="banner warn">{tc('noDepts')} <a href="/admin/departments">{tc('openDepts')}</a></div>}
      {l && l.cycle.period === period && l.cycle.ws === ws && <div key={`${ws}/${period}`} class="cy-tabbody">
      {tab === 'start' && <StartTab ws={ws} period={period} l={l} reload={loaded.reload} />}
      {tab === 'calc' && <CalcTab ws={ws} period={period} l={l} reload={loaded.reload} />}
      {tab === 'control' && <ControlTab ws={ws} period={period} l={l} reload={loaded.reload} />}
      {tab === 'workflow' && <WorkflowTab ws={ws} period={period} l={l} />}
      {tab === 'routes' && <RoutesTab ws={ws} period={period} l={l} />}
      </div>}
    </section>
  );
}
