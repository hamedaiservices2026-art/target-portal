// Admin › Target cycle (handover sections 3, 4, 6, 9): the 8-step start with
// every upload, the Commercial Director hand-off, the target calculator, the
// send / restart control per Head of Department, route targets and variance.
import { useLocation } from 'preact-iso';
import { useMemo, useState } from 'preact/hooks';
import { CATEGORIES } from '../../../shared/calc/packs';
import { pago as pagoOf } from '../../../shared/calc/periods';
import type { Workspace } from '../../../worker/auth';
import type { CycleDto, CycleSettings } from '../../../worker/services/cycle';
import type { DataStatus, OrgDto } from '../../../worker/services/cycleData';
import type { ExportResult } from '../../../worker/services/export';
import { api } from '../../api';
import { ConfirmButton, errText, PageHead } from '../../components/AdminBits';
import { readSheet, readSheets, writeXlsx } from '../../excel';
import { fmtDateTime } from '../../format';
import { fmtNum, useLang } from '../../i18n';
import { calculate, catMap, reconciliation, startNewTarget, sumCat, total, type DeptCalc, type Grid, type NtSource } from '../../cycle/compute';
import { tc } from '../../cycle/i18n';
import { clearRouteCache, getCycle, getOrg, loadMonthData, loadRouteData, useAsync } from '../../cycle/load';
import {
  packIndex, parseAop, parseChannelGrid, parseFyTarget, parseNewTargetByPack, parsePrevTargets, parseSales, sheetMonth, TEMPLATES,
  type Check, type RouteMonthData,
} from '../../cycle/parsers';
import { Checks, defaultPeriod, downloadCsv, fmtCases, Section, Tabs, WsPeriod } from '../../cycle/ui';

type Loaded = { cycle: CycleDto; org: OrgDto; status: DataStatus };
type TabId = 'start' | 'calc' | 'control' | 'routes';

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
function UploadStep({ n, title, help, template, done, locked, parse, upload, multiSheet }: {
  n: number; title: string; help: string; template: keyof typeof TEMPLATES; done: boolean; locked: boolean;
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
  const tpl = TEMPLATES[template]!;

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
    <div class={`cy-step${done ? ' done' : ''}`} data-testid={`step-${n}`}>
      <div class="cy-step-head">
        <span class="cy-step-n">{done ? '✓' : n}</span>
        <div><b>{title}</b><p class="muted small">{help}</p></div>
        <span class="spacer" />
        <button type="button" class="btn" onClick={() => void writeXlsx(tpl.file, tpl.columns, tpl.sample)}>{tc('downloadTemplate')}</button>
      </div>
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
      await api('PUT', `/api/admin/cycle/${ws}/${period}/settings`, s);
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
          <span>{tc('ntMode')}</span>
          <select value={s.ntMode} onChange={(e) => setS({ ...s, ntMode: e.currentTarget.value as 'pack' | 'dept' })}>
            <option value="pack">{tc('ntModePack')}</option>
            <option value="dept">{tc('ntModeDept')}</option>
          </select>
        </label>
        <label class="field">
          <span>{tc('avgMonths')}</span>
          <input value={s.avgMonths.join(', ')} onChange={(e) => {
            const list = e.currentTarget.value.split(/[,\s]+/).filter((x) => /^\d{4}-\d{2}$/.test(x));
            if (list.length) setS({ ...s, avgMonths: list });
          }} />
        </label>
      </div>
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
  const [preview, setPreview] = useState<{ nt: Grid; source: NtSource } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [deptChecks, setDeptChecks] = useState<Check[]>([]);
  const cats = catMap(org);

  async function prepare() {
    setBusy(true);
    setErr(null);
    try {
      const [nt, fy, aop, dc] = await Promise.all([
        loadMonthData<{ mode: 'pack' | 'dept'; byPack: Grid; byChannel?: Record<string, Grid> }>(ws, 'new_target'),
        loadMonthData<Grid>(ws, 'fy_target'), loadMonthData<Record<string, { cases: number; nr: number | null }>>(ws, 'aop'),
        loadMonthData<Record<string, Grid>>(ws, 'dept_channel'),
      ]);
      const pm = pagoOf(period);
      const months = [pm, `${period.slice(0, 4)}-${period.slice(5)}`].concat(cycle.settings.avgMonths);
      const [sales, prev] = await Promise.all([loadRouteData(ws, 'sales', cycle.settings.avgMonths), loadRouteData(ws, 'prev_target', months)]);
      const r = startNewTarget(period, { newTarget: nt[period] ?? null, fyTarget: fy, aop, deptChannel: dc, prevTargets: prev.data, sales: sales.data }, cats);
      setPreview(r);
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

  async function deptFile(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!f) return;
    setErr(null);
    try {
      const channels = org.depts.flatMap((d) => d.channels.map((c) => c.channel));
      const r = parseChannelGrid(await readSheet(f), channels, packIndex(org.packs.map((p) => p.code)));
      setDeptChecks(r.checks);
      if (r.checks.some((c) => c.level === 'error')) return;
      const dept: Record<string, Grid> = {};
      for (const d of org.depts) {
        const g: Grid = {};
        for (const c of d.channels) for (const [p, n] of Object.entries(r.byChannel[c.channel] ?? {})) g[p] = (g[p] ?? 0) + n;
        dept[String(d.id)] = g;
      }
      await api('PUT', `/api/admin/cycle/${ws}/${period}/dept-target`, { dept });
      onDone();
    } catch (x) {
      setErr(errText(x));
    }
  }

  const done = cycle.settings.cdStep ? cycle.cdStatus === 'with_cd' || cycle.cdStatus === 'submitted' : cycle.dept !== null;
  const srcLabel: Record<NtSource, string> = {
    uploaded: tc('srcUploaded'), fy_target: tc('srcFy'), aop_ratio: tc('srcAop'), pago_target: tc('srcPago'), avg_sales: tc('srcAvg'), none: tc('srcNone'),
  };
  return (
    <div class={`cy-step${done ? ' done' : ''}`} data-testid="step-8">
      <div class="cy-step-head">
        <span class="cy-step-n">{done ? '✓' : 8}</span>
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
              <p>{tc('ntSource')}: <b>{srcLabel[preview.source]}</b> · {tc('ntTotal')}: <b>{fmtNum(total(preview.nt))}</b></p>
              <div class="tablewrap"><table class="ad-table cy-table">
                <thead><tr><th>{tc('category')}</th><th class="num">{tc('newTarget')}</th></tr></thead>
                <tbody>{CATEGORIES.map((c) => <tr key={c}><td>{c}</td><td class="num">{fmtNum(sumCat(preview.nt, cats, c))}</td></tr>)}</tbody>
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
  const routes = new Set(org.leaves.map((x) => x.routeCode));
  const locked = cycle.cdStatus === 'with_cd' || cycle.cdStatus === 'submitted';
  const pm = pagoOf(period);
  const done = [
    exists,
    has(status, 'new_target', period),
    status.some((s) => s.kind === 'aop'),
    status.some((s) => s.kind === 'fy_target'),
    cycle.settings.avgMonths.every((m) => has(status, 'sales', m)),
    has(status, 'prev_target', pm),
    has(status, 'dept_channel', pm),
    cycle.settings.cdStep ? cycle.cdStatus === 'with_cd' || cycle.cdStatus === 'submitted' : cycle.dept !== null,
  ];
  const n = done.filter(Boolean).length;
  const after = (msg: string) => { reload(); return msg; };

  return (
    <>
      <div class="cy-progress" aria-label={tc('stepsDone', { n, of: 8 })}>
        <div class="bar"><span style={{ width: `${(n / 8) * 100}%` }} /></div>
        <b>{tc('stepsDone', { n, of: 8 })}</b>
      </div>
      <SettingsStep ws={ws} period={period} cycle={cycle} exists={exists} onSaved={reload} />
      {exists && (
        <>
          {cycle.settings.ntMode === 'pack' ? (
            <UploadStep n={2} title={tc('step2a')} help={tc('step2aHelp')} template="new_target_pack" done={done[1]!} locked={locked}
              parse={({ rows }) => {
                const r = parseNewTargetByPack(rows!, period, idx);
                return { checks: r.checks, summary: tc('sumPacks', { n: Object.keys(r.byPack).length, total: fmtNum(total(r.byPack)) }), payload: r.byPack };
              }}
              upload={async (byPack) => after(tc('savedMonths', { n: await uploadMonths(ws, 'new_target', { [period]: { mode: 'pack', byPack } }) }))} />
          ) : (
            <UploadStep n={2} title={tc('step2b')} help={tc('step2bHelp')} template="new_target_dept" done={done[1]!} locked={locked}
              parse={({ rows }) => {
                const r = parseChannelGrid(rows!, channels, idx);
                const byPack: Grid = {};
                for (const g of Object.values(r.byChannel)) for (const [p, v] of Object.entries(g)) byPack[p] = (byPack[p] ?? 0) + v;
                return { checks: r.checks, summary: tc('sumPacks', { n: Object.keys(byPack).length, total: fmtNum(total(byPack)) }), payload: { mode: 'dept', byPack, byChannel: r.byChannel } };
              }}
              upload={async (payload) => after(tc('savedMonths', { n: await uploadMonths(ws, 'new_target', { [period]: payload }) }))} />
          )}
          <UploadStep n={3} title={tc('step3')} help={tc('step3Help')} template="aop" done={done[2]!} locked={locked} multiSheet
            parse={({ sheets }) => {
              const r = parseAop(sheets!, idx);
              return { checks: r.checks, summary: tc('sumMonths', { n: Object.keys(r.byMonth).length }), payload: r.byMonth };
            }}
            upload={async (p) => after(tc('savedMonths', { n: await uploadMonths(ws, 'aop', p as Record<string, unknown>) }))} />
          <UploadStep n={4} title={tc('step4')} help={tc('step4Help')} template="fy_target" done={done[3]!} locked={locked} multiSheet
            parse={({ sheets }) => {
              const r = parseFyTarget(sheets!, idx);
              return { checks: r.checks, summary: tc('sumMonths', { n: Object.keys(r.byMonth).length }), payload: r.byMonth };
            }}
            upload={async (p) => after(tc('savedMonths', { n: await uploadMonths(ws, 'fy_target', p as Record<string, unknown>) }))} />
          <UploadStep n={5} title={tc('step5')} help={tc('step5Help')} template="sales" done={done[4]!} locked={false}
            parse={({ rows }) => {
              const r = parseSales(rows!, idx, routes);
              return { checks: r.checks, summary: tc('sumMonths', { n: Object.keys(r.data).length }), payload: r.data };
            }}
            upload={async (p, file, prog) => after(tc('savedRows', { n: fmtNum(await uploadRoutes(ws, 'sales', p as RouteMonthData, null, file, prog)) }))} />
          <UploadStep n={6} title={tc('step6')} help={tc('step6Help')} template="prev_target" done={done[5]!} locked={locked}
            parse={({ rows }) => {
              const r = parsePrevTargets(rows!, idx);
              return { checks: r.checks, summary: tc('sumMonths', { n: Object.keys(r.data).length }), payload: r };
            }}
            upload={async (p, file, prog) => {
              const r = p as ReturnType<typeof parsePrevTargets>;
              return after(tc('savedRows', { n: fmtNum(await uploadRoutes(ws, 'prev_target', r.data, r.extra as never, file, prog)) }));
            }} />
          <UploadStep n={7} title={tc('step7')} help={tc('step7Help')} template="dept_channel" done={done[6]!} locked={locked} multiSheet
            parse={({ sheets }) => {
              const byMonth: Record<string, Record<string, Grid>> = {};
              const checks: Check[] = [];
              for (const s of sheets!) {
                const m = sheetMonth(s);
                if (!m) { checks.push({ level: 'info', text: tc('sheetNoMonth', { sheet: s.sheet }) }); continue; }
                const r = parseChannelGrid(s.data, channels, idx);
                checks.push(...r.checks.map((c) => ({ ...c, text: `${s.sheet}: ${c.text}` })));
                if (!r.checks.some((c) => c.level === 'error')) byMonth[m] = r.byChannel;
              }
              if (!Object.keys(byMonth).length) checks.push({ level: 'error', text: tc('noMonthSheets') });
              return { checks, summary: tc('sumMonths', { n: Object.keys(byMonth).length }), payload: byMonth };
            }}
            upload={async (p) => after(tc('savedMonths', { n: await uploadMonths(ws, 'dept_channel', p as Record<string, unknown>) }))} />
          <SendStep ws={ws} period={period} l={l} onDone={reload} />
        </>
      )}
    </>
  );
}

// ---------- tab: calculator ----------

function CalcTab({ ws, period, l, reload }: { ws: Workspace; period: string; l: Loaded; reload: () => void }) {
  const [lang] = useLang();
  const { cycle, org } = l;
  const [res, setRes] = useState<{ depts: DeptCalc[]; problems: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const cats = catMap(org);
  const deptName = (id: number) => org.depts.find((d) => d.id === id)?.name ?? String(id);

  if (!cycle.dept) return <p class="card muted">{cycle.settings.cdStep ? tc('calcWaitCd') : tc('calcWaitDept')}</p>;

  async function run() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const pm = pagoOf(period);
      const [sales, prev] = await Promise.all([loadRouteData(ws, 'sales', cycle.settings.avgMonths), loadRouteData(ws, 'prev_target', [period, pm])]);
      const routeTargets = prev.data[period] ?? prev.data[pm] ?? {};
      setRes(calculate({ org, dept: cycle.dept!, sales: sales.data, avgMonths: cycle.settings.avgMonths, routeTargets }));
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!res) return;
    setBusy(true);
    setErr(null);
    try {
      const calc = Object.fromEntries(res.depts.map((d) => [String(d.deptId), d.routes]));
      const notes = { at: new Date().toISOString(), problems: res.problems, depts: res.depts.map((d) => ({ deptId: d.deptId, basis: d.result.basisCount, fallback: d.result.fallbackPacks })) };
      const out = await api<{ applied: string[]; kept: string[] }>('PUT', `/api/admin/cycle/${ws}/${period}/calc`, { calc, notes });
      setMsg(tc('calcApplied', { n: out.applied.length, kept: out.kept.length }));
      reload();
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!res) return;
    const rows: (string | number)[][] = [];
    for (const d of res.depts) for (const [r, g] of Object.entries(d.routes)) for (const [p, n] of Object.entries(g)) rows.push([deptName(d.deptId), r, p, n]);
    void writeXlsx(`route_targets_${ws}_${period}.xlsx`, ['Head of Department', 'Route Code', 'Sales Target Category', 'Cases'], rows, ['string', 'string', 'string', 'number']);
  }

  const rec = res ? reconciliation(org, cycle.dept, res.depts, null) : null;
  return (
    <>
      <Section title={tc('calcTitle')} right={<span class="muted small">{tc('avgOver', { months: cycle.settings.avgMonths.join(', ') })}</span>}>
        <p class="muted small">{tc('calcHelp')}</p>
        <div class="actions">
          <button type="button" class="btn" disabled={busy} onClick={() => void run()}>{tc('calculate')}</button>
          {res && <button type="button" class="btn primary" disabled={busy || !rec?.ok} onClick={() => void apply()}>{tc('apply')}</button>}
          {res && <button type="button" class="btn" onClick={download}>{tc('downloadExcel')}</button>}
        </div>
        {cycle.calcDepts.length > 0 && <p class="small muted">{tc('calcStored', { n: cycle.calcDepts.length })} {cycle.updatedAt && fmtDateTime(cycle.updatedAt, lang)}</p>}
        {msg && <div class="banner ok" role="status">{msg}</div>}
        {err && <div class="alert" role="alert">{err}</div>}
        {res && res.problems.length > 0 && <Checks checks={res.problems.map((text) => ({ level: 'warning', text }))} />}
      </Section>
      {res && (
        <Section title={tc('calcNotes')}>
          <div class="tablewrap"><table class="ad-table cy-table">
            <thead><tr><th>{tc('head')}</th><th class="num">{tc('routes')}</th><th class="num">{tc('total')}</th><th>{tc('fallbacks')}</th></tr></thead>
            <tbody>
              {res.depts.map((d) => (
                <tr key={d.deptId}>
                  <td>{deptName(d.deptId)}</td>
                  <td class="num">{fmtNum(Object.keys(d.routes).length)}</td>
                  <td class="num">{fmtNum(Object.values(d.routes).reduce((s, g) => s + total(g), 0))}</td>
                  <td class="small">
                    {d.result.fallbackPacks.category_sales.length > 0 && <div>{tc('fbCategory', { n: d.result.fallbackPacks.category_sales.length })}</div>}
                    {d.result.fallbackPacks.route_target.length > 0 && <div>{tc('fbRouteTarget', { n: d.result.fallbackPacks.route_target.length })}</div>}
                    {d.result.fallbackPacks.equal.length > 0 && <div>{tc('fbEqual', { n: d.result.fallbackPacks.equal.length })}</div>}
                    {!d.result.fallbackPacks.category_sales.length && !d.result.fallbackPacks.route_target.length && !d.result.fallbackPacks.equal.length && tc('fbNone')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {rec && (
            <>
              <h3>{tc('reconTitle')} <span class={rec.ok ? 'status ok' : 'status bad'}>{rec.ok ? tc('ok') : tc('notOk')}</span></h3>
              <div class="tablewrap"><table class="ad-table cy-table">
                <thead><tr><th>{tc('head')}</th><th>{tc('category')}</th><th class="num">{tc('deptTarget')}</th><th class="num">{tc('calculated')}</th><th class="num">{tc('diff')}</th></tr></thead>
                <tbody>{rec.lines.map((x, i) => (
                  <tr key={i} class={x.ok ? '' : 'bad'}><td>{x.dept}</td><td>{x.category}</td><td class="num">{fmtNum(x.target)}</td><td class="num">{fmtNum(x.calculated)}</td><td class="num">{fmtNum(x.diff)}</td></tr>
                ))}</tbody>
              </table></div>
            </>
          )}
        </Section>
      )}
      <p class="small muted">{tc('categories')}: {CATEGORIES.join(', ')} · {[...cats.values()].length} {tc('packsWord')}</p>
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
  return (
    <Section title={tc('controlTitle')} right={cycle.monthId ? <a class="btn" href={`/admin/months/${cycle.monthId}`}>{tc('openBoard')}</a> : undefined}>
      {!ready && <p class="muted">{tc('controlNotReady')}</p>}
      {err && <div class="alert" role="alert">{err}</div>}
      <div class="tablewrap"><table class="ad-table cy-table">
        <thead><tr>
          <th>{tc('head')}</th><th>{tc('status')}</th><th class="num">{tc('sentTotal')}</th><th>{tc('sentAt')}</th><th>{tc('progress')}</th><th>{tc('comment')}</th><th />
        </tr></thead>
        <tbody>{cycle.heads.map((h) => {
          const pr = cycle.progress[String(h.deptId)];
          const canSend = ready && cycle.calcDepts.includes(String(h.deptId)) && (h.status === 'draft' || h.status === 'returned');
          return (
            <tr key={h.deptId} data-testid="head-row">
              <td><b>{h.name}</b><div class="muted small">{h.headName ?? tc('noHeadUser')}</div></td>
              <td><span class={`pill ${h.status}`}>{tc(`hs_${h.status}` as 'hs_draft')}</span>{h.monthState === 'complete' && <span class="pill ok">{tc('final')}</span>}</td>
              <td class="num">{fmtCases(h.sentTotal)}</td>
              <td class="small">{fmtDateTime(h.sentAt, lang)}</td>
              <td class="small">{pr ? tc('progressText', { s: pr.submitted, o: pr.in_progress, w: pr.waiting }) : '—'}</td>
              <td class="small">{h.comment ?? ''}</td>
              <td class="act">
                {canSend && <button type="button" class="btn primary" disabled={busy === h.deptId} onClick={() => void send(h.deptId)}>{tc('sendToHead')}</button>}
                {h.status !== 'draft' && <ConfirmButton label={tc('restart')} question={tc('restartQ')} yesLabel={tc('restart')} onConfirm={() => restart(h.deptId)} />}
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
        <button type="button" class="btn" onClick={() => downloadCsv(`route_targets_${ws}_${period}.csv`, [...exp.columns, 'Format'], rows.map((r) => [...r, 'Cases']))}>{tc('downloadCsv')}</button>
      }>
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
  const { route } = useLocation();
  const ws: Workspace = wsParam === 'ka' ? 'ka' : 'ops';
  const period = periodParam && /^\d{4}-\d{2}$/.test(periodParam) ? periodParam : defaultPeriod();
  const [tab, setTab] = useState<TabId>('start');
  const loaded = useAsync<Loaded>(async () => {
    const [cycle, org, st] = await Promise.all([getCycle(ws, period), getOrg(ws), api<{ status: DataStatus }>('GET', `/api/data/${ws}/status`)]);
    return { cycle, org, status: st.status };
  }, [ws, period]);
  const l = loaded.data;
  return (
    <section class="cycle" data-testid="admin-cycle">
      <PageHead title={tc('cycleTitle')} intro={tc('cycleIntro')} />
      <WsPeriod ws={ws} period={period} onChange={(w, p) => route(`/admin/cycle/${w}/${p}`)} />
      <Tabs<TabId> value={tab} onChange={setTab} items={[
        { id: 'start', label: tc('tabStart') }, { id: 'calc', label: tc('tabCalc') }, { id: 'control', label: tc('tabControl') }, { id: 'routes', label: tc('tabRoutes') },
      ]} />
      {loaded.error && <div class="alert" role="alert">{loaded.error} <button type="button" class="btn" onClick={loaded.reload}>{tc('retry')}</button></div>}
      {!l && !loaded.error && <p class="muted">{tc('loading')}</p>}
      {l && l.org.depts.length === 0 && <div class="banner warn">{tc('noDepts')} <a href="/admin/departments">{tc('openDepts')}</a></div>}
      {l && tab === 'start' && <StartTab ws={ws} period={period} l={l} reload={loaded.reload} />}
      {l && tab === 'calc' && <CalcTab ws={ws} period={period} l={l} reload={loaded.reload} />}
      {l && tab === 'control' && <ControlTab ws={ws} period={period} l={l} reload={loaded.reload} />}
      {l && tab === 'routes' && <RoutesTab ws={ws} period={period} l={l} />}
    </section>
  );
}
