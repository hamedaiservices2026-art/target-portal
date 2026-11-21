// The monthly target cycle per workspace (handover section 3):
//   Admin prepares -> Commercial Director splits by department (optional step)
//   -> Admin calculates per route and sends to each Head of Department
//   -> Head approves (or returns) -> the existing top-down distribution runs.
//
// Heavy work (the CD's default split from sales, the cascade to routes) runs
// in the browser with src/shared/calc; the Worker re-checks every total before
// it stores anything, and computes the CD final fit itself (it is small:
// packs x departments per category).
import { cdFinal, cdSubmitProblems, type CdWork, type PackCat } from '../../shared/calc/cd';
import type { SessionUser, Workspace } from '../auth';
import { all, one } from '../db';
import type { Env } from '../index';
import { auditStatement } from './audit';
import { month as parseMonth } from './cycleData';
import { ApiError, bad, forbidden, notFound, writeBatch, type Obj } from './masters';
import { createMonth, resetDept, startDept } from './months';
import { ADMINS, CDS, notifySql, type NotifyText } from './notify';

const MAX_VALUE = 1_000_000_000;
/** calc_json is limited well below D1's 2 MB per value. */
const MAX_CALC_JSON = 1_800_000;

export type CdStatus = 'draft' | 'with_cd' | 'submitted' | 'returned';
export type HeadStatus = 'draft' | 'pending' | 'approved' | 'returned';

export type CycleSettings = {
  /** The Commercial Director step (on by default). Off: Admin uploads the department target directly. */
  cdStep: boolean;
  /** Due dates (YYYY-MM-DD) per level; defaults: Head +2 days, Manager +4, Supervisor +6 from opening. */
  deadlines: { head: string | null; manager: string | null; supervisor: string | null };
  /** Months averaged for the splits (default: the 3 before the target month). */
  avgMonths: string[];
  /** Step 2 option: New Target by pack, or by pack & department. */
  ntMode: 'pack' | 'dept';
};

/** The Commercial Director's work (CD tabs 1-3). */
export type { CdWork };

export type CycleDto = {
  ws: Workspace;
  period: string;
  settings: CycleSettings;
  cdStatus: CdStatus;
  cdComment: string | null;
  cd: CdWork | null;
  /** Department target per pack used by the calculator (CD final, or uploaded with the CD step off). */
  dept: Record<string, Record<string, number>> | null;
  calcDepts: string[];
  calcNotes: unknown;
  version: number;
  updatedAt: string;
  monthId: number | null;
  heads: HeadDto[];
  /** Workflow progress per department: nodes by status. */
  progress: Record<string, { waiting: number; in_progress: number; submitted: number }>;
};

export type HeadDto = {
  deptId: number; code: string; name: string; status: HeadStatus; sentTotal: number | null; sentByCategory: Record<string, number> | null;
  sentAt: string | null; decidedAt: string | null; comment: string | null; monthState: string | null;
  rootNodeId: number | null; headUserId: number | null; headName: string | null;
};

type CycleRow = {
  ws: Workspace; period: string; settings_json: string; cd_status: CdStatus; cd_comment: string | null; cd_json: string | null;
  dept_json: string | null; calc_depts: string | null; calc_notes: string | null; version: number; updated_at: string;
};

// ---------- helpers ----------

function addDays(period: string, days: number): string {
  const d = new Date(`${period}-01T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days - 1);
  return d.toISOString().slice(0, 10);
}

function prevMonths(period: string, n: number): string[] {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = n; i >= 1; i--) {
    const idx = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

export function defaultSettings(period: string): CycleSettings {
  return {
    cdStep: true,
    deadlines: { head: addDays(period, 2), manager: addDays(period, 4), supervisor: addDays(period, 6) },
    avgMonths: prevMonths(period, 3),
    ntMode: 'pack',
  };
}

function parseJson<T>(s: string | null): T | null {
  if (s === null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

const isCd = (u: SessionUser, ws: Workspace) => u.cd.includes(ws);
const isAdmin = (u: SessionUser) => u.role === 'admin';
const conflict = (detail: string) => new ApiError(409, { error: 'conflict', detail });

function whole(n: unknown, where: string): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_VALUE) throw bad(`${where} must be a whole number of at least 0`);
  return n;
}

function packGrid(v: unknown, where: string): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`${where} must be an object of pack to cases`);
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Obj)) out[k] = whole(n, `${where} ${k}`);
  return out;
}

async function cycleRow(db: D1Database, ws: Workspace, period: string): Promise<CycleRow | null> {
  return one<CycleRow>(db,
    `SELECT ws, period, settings_json, cd_status, cd_comment, cd_json, dept_json,
            (SELECT json_group_array(key) FROM json_each(COALESCE(calc_json, '{}'))) AS calc_depts, calc_notes, version, updated_at
     FROM cycles WHERE ws = ? AND period = ?`, ws, period);
}

async function requireCycle(db: D1Database, ws: Workspace, period: string): Promise<CycleRow> {
  const c = await cycleRow(db, ws, period);
  if (!c) throw notFound();
  return c;
}

/** Version-guarded cycle UPDATE; `sets` are SQL assignments with their args. */
function updateCycle(db: D1Database, ws: Workspace, period: string, version: number, sets: string, args: (string | number | null)[]): D1PreparedStatement {
  return db.prepare(
    `UPDATE cycles SET ${sets}, version = version + 1, updated_at = ? WHERE ws = ? AND period = ? AND version = ?`,
  ).bind(...args, new Date().toISOString(), ws, period, version);
}

function checkApplied(res: D1Result[], idx = 0): void {
  if ((res[idx]!.meta.changes ?? 0) !== 1) throw new ApiError(409, { error: 'stale' });
}

const txt = (en: string, ar: string): NotifyText => ({ en, ar });

// ---------- read ----------

export async function getCycle(db: D1Database, user: SessionUser, ws: Workspace, periodRaw: string): Promise<CycleDto> {
  const period = parseMonth(periodRaw, 'period');
  const c = await cycleRow(db, ws, period);
  const m = await one<{ id: number }>(db, `SELECT id FROM months WHERE period = ?`, period);
  const heads = await all<{
    id: number; code: string; name: string; status: HeadStatus | null; sent_total: number | null; sent_json: string | null;
    sent_at: string | null; decided_at: string | null; comment: string | null; state: string | null; root_id: number | null;
    head_user_id: number | null; head_name: string | null;
  }>(db,
    `SELECT d.id, d.code, d.name, h.status, h.sent_total, h.sent_json, h.sent_at, h.decided_at, h.comment,
            md.state, r.id AS root_id, r.manager_user_id AS head_user_id, u.name AS head_name
     FROM departments d
     LEFT JOIN head_approvals h ON h.period = ? AND h.dept_id = d.id
     LEFT JOIN month_depts md ON md.month_id = ? AND md.dept_id = d.id
     LEFT JOIN nodes r ON r.dept_id = d.id AND r.parent_id IS NULL
     LEFT JOIN users u ON u.id = r.manager_user_id
     WHERE d.workspace = ? ORDER BY d.sort, d.code`, period, m?.id ?? -1, ws);
  const prog = m ? await all<{ dept_id: number; status: string; n: number }>(db,
    `SELECT mn.dept_id, mn.status, COUNT(*) AS n FROM month_nodes mn JOIN departments d ON d.id = mn.dept_id
     WHERE mn.month_id = ? AND d.workspace = ? GROUP BY mn.dept_id, mn.status`, m.id, ws) : [];
  const progress: CycleDto['progress'] = {};
  for (const p of prog) {
    const e = (progress[String(p.dept_id)] ??= { waiting: 0, in_progress: 0, submitted: 0 });
    if (p.status === 'waiting' || p.status === 'in_progress' || p.status === 'submitted') e[p.status] = p.n;
  }

  const full = isAdmin(user) || isCd(user, ws);
  const headList: HeadDto[] = heads
    .filter((h) => full || h.head_user_id === user.id)
    .map((h) => ({
      deptId: h.id, code: h.code, name: h.name, status: h.status ?? 'draft', sentTotal: h.sent_total,
      sentByCategory: parseJson<Record<string, number>>(h.sent_json), sentAt: h.sent_at, decidedAt: h.decided_at, comment: h.comment,
      monthState: h.state, rootNodeId: h.root_id, headUserId: h.head_user_id, headName: h.head_name,
    }));
  if (!full && headList.length === 0 && !m) throw forbidden();
  const settings = c ? { ...defaultSettings(period), ...parseJson<CycleSettings>(c.settings_json) } : defaultSettings(period);
  return {
    ws, period, settings,
    cdStatus: c?.cd_status ?? 'draft',
    cdComment: c?.cd_comment ?? null,
    cd: full ? parseJson<CdWork>(c?.cd_json ?? null) : null,
    dept: full ? parseJson<Record<string, Record<string, number>>>(c?.dept_json ?? null) : null,
    calcDepts: parseJson<string[]>(c?.calc_depts ?? null) ?? [],
    calcNotes: full ? parseJson(c?.calc_notes ?? null) : null,
    version: c?.version ?? 0,
    updatedAt: c?.updated_at ?? '',
    monthId: m?.id ?? null,
    heads: headList,
    progress,
  };
}

/** The applied route calculation as stored (`{deptId: {routeCode: {pack: cases}}}`), raw JSON. */
export async function getCalc(db: D1Database, user: SessionUser, ws: Workspace, periodRaw: string): Promise<string> {
  if (!isAdmin(user) && !isCd(user, ws)) throw forbidden();
  const period = parseMonth(periodRaw, 'period');
  const r = await one<{ calc_json: string | null }>(db, `SELECT calc_json FROM cycles WHERE ws = ? AND period = ?`, ws, period);
  return r?.calc_json ?? '{}';
}

/** Cycles of a workspace, newest first. */
export async function listCycles(db: D1Database, ws: Workspace): Promise<{ period: string; cdStatus: CdStatus; updatedAt: string }[]> {
  return all(db, `SELECT period, cd_status AS cdStatus, updated_at AS updatedAt FROM cycles WHERE ws = ? ORDER BY period DESC`, ws);
}

// ---------- Admin: open the cycle and its settings (step 1) ----------

function parseSettings(body: Obj, period: string): CycleSettings {
  const base = defaultSettings(period);
  const s = { ...base };
  if (body.cdStep !== undefined) {
    if (typeof body.cdStep !== 'boolean') throw bad('cdStep must be true or false');
    s.cdStep = body.cdStep;
  }
  if (body.ntMode !== undefined) {
    if (body.ntMode !== 'pack' && body.ntMode !== 'dept') throw bad('ntMode must be pack or dept');
    s.ntMode = body.ntMode;
  }
  if (body.avgMonths !== undefined) {
    if (!Array.isArray(body.avgMonths) || body.avgMonths.length === 0 || body.avgMonths.length > 24) throw bad('avgMonths must list 1 to 24 months');
    s.avgMonths = [...new Set(body.avgMonths.map((m) => parseMonth(m, 'avgMonths')))].sort();
  }
  if (body.deadlines !== undefined) {
    const d = body.deadlines as Obj;
    if (!d || typeof d !== 'object') throw bad('deadlines must be an object');
    const date = (v: unknown, f: string) => {
      if (v === null) return null;
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`deadlines.${f} must be YYYY-MM-DD`);
      return v;
    };
    s.deadlines = { head: date(d.head ?? null, 'head'), manager: date(d.manager ?? null, 'manager'), supervisor: date(d.supervisor ?? null, 'supervisor') };
  }
  return s;
}

/** Creates the cycle (first save) or updates its settings. */
export async function saveSettings(db: D1Database, actorId: number, ws: Workspace, periodRaw: string, body: Obj): Promise<CycleSettings> {
  const period = parseMonth(periodRaw, 'period');
  const cur = await cycleRow(db, ws, period);
  const merged = { ...(cur ? parseJson<Obj>(cur.settings_json) ?? {} : {}), ...body };
  const settings = parseSettings(merged, period);
  const now = new Date().toISOString();
  if (!cur) {
    await writeBatch(db, [
      db.prepare(`INSERT INTO cycles(ws, period, settings_json, updated_at) VALUES (?, ?, ?, ?)`).bind(ws, period, JSON.stringify(settings), now),
      auditStatement(db, actorId, 'cycle.open', {}, { ws, period, settings }),
    ], 'this cycle already exists');
    return settings;
  }
  if (cur.cd_status === 'with_cd' && body.cdStep === false) throw conflict('the target is with the Commercial Director: recall it first');
  const res = await writeBatch(db, [
    updateCycle(db, ws, period, cur.version, 'settings_json = ?', [JSON.stringify(settings)]),
    auditStatement(db, actorId, 'cycle.settings', {}, { ws, period, settings }),
  ], 'conflict');
  checkApplied(res);
  // Deadlines of the month the cycle runs in (the final level's date).
  if (settings.deadlines.supervisor) {
    await db.prepare(`UPDATE months SET deadline = ? WHERE period = ?`).bind(settings.deadlines.supervisor, period).run();
  }
  return settings;
}

// ---------- Commercial Director step (section 5) ----------

export async function sendToCd(db: D1Database, actorId: number, ws: Workspace, periodRaw: string, body: Obj): Promise<void> {
  const period = parseMonth(periodRaw, 'period');
  const c = await requireCycle(db, ws, period);
  const settings = parseJson<CycleSettings>(c.settings_json) ?? defaultSettings(period);
  if (!settings.cdStep) throw conflict('the Commercial Director step is off for this cycle');
  if (c.cd_status !== 'draft' && c.cd_status !== 'returned') throw conflict(`the target is ${c.cd_status}`);
  // The starting New Target per pack (worked out by the browser from the uploads, first source found wins).
  const cd = parseJson<CdWork>(c.cd_json);
  let work: CdWork | null = cd;
  if (body.nt !== undefined) {
    const nt = packGrid(body.nt, 'nt');
    work = { nt, ntOk: false, dm: {}, splitNt: {}, basis: {}, gm: {}, colJ: {}, ...(cd ? { gm: cd.gm, colJ: cd.colJ } : {}) };
    if (cd && JSON.stringify(cd.nt) === JSON.stringify(nt)) work = { ...cd, ntOk: cd.ntOk };
  }
  if (!work || Object.keys(work.nt).length === 0) throw bad('nt (the New Target per pack) is required the first time');
  const res = await writeBatch(db, [
    updateCycle(db, ws, period, c.version, `cd_status = 'with_cd', cd_comment = NULL, cd_json = ?`, [JSON.stringify(work)]),
    auditStatement(db, actorId, 'cycle.cd_send', {}, { ws, period }),
    notifySql(db, CDS(ws).sql, CDS(ws).args, 'cd_sent',
      txt(`The ${period} target is waiting for your split.`, `هدف ${period} بانتظار توزيعك.`), `/cd/${ws}/${period}`),
  ], 'conflict');
  checkApplied(res);
}

export async function recallFromCd(db: D1Database, actorId: number, ws: Workspace, periodRaw: string): Promise<void> {
  const period = parseMonth(periodRaw, 'period');
  const c = await requireCycle(db, ws, period);
  if (c.cd_status !== 'with_cd' && c.cd_status !== 'submitted') throw conflict(`the target is ${c.cd_status}`);
  if (c.cd_status === 'submitted') {
    const sent = await one<{ n: number }>(db,
      `SELECT COUNT(*) AS n FROM head_approvals h JOIN departments d ON d.id = h.dept_id
       WHERE h.period = ? AND d.workspace = ? AND h.status IN ('pending', 'approved')`, period, ws);
    if (sent && sent.n > 0) throw conflict('the target was already sent to a Head of Department: restart those channels first');
  }
  const res = await writeBatch(db, [
    updateCycle(db, ws, period, c.version, `cd_status = 'draft'`, []),
    auditStatement(db, actorId, 'cycle.cd_recall', {}, { ws, period, from: c.cd_status }),
    notifySql(db, CDS(ws).sql, CDS(ws).args, 'cd_recalled',
      txt(`Admin recalled the ${period} target.`, `استرجع المسؤول هدف ${period}.`), `/cd/${ws}/${period}`),
  ], 'conflict');
  checkApplied(res);
}

function parseCdWork(v: unknown): CdWork {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('cd must be an object');
  const o = v as Obj;
  const nested = (x: unknown, where: string, depth: 1 | 2): Record<string, any> => {
    if (x === undefined) return {};
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad(`${where} must be an object`);
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(x as Obj)) {
      out[k] = depth === 1 ? packGrid(inner, `${where}.${k}`) : nested(inner, `${where}.${k}`, 1);
    }
    return out;
  };
  const basis: Record<string, string> = {};
  if (o.basis !== undefined) {
    if (!o.basis || typeof o.basis !== 'object') throw bad('basis must be an object');
    for (const [k, b] of Object.entries(o.basis as Obj)) if (typeof b === 'string') basis[k] = b.slice(0, 40);
  }
  return {
    nt: packGrid(o.nt, 'nt'),
    ntOk: o.ntOk === true,
    dm: nested(o.dm, 'dm', 2) as CdWork['dm'],
    splitNt: o.splitNt === undefined ? {} : packGrid(o.splitNt, 'splitNt'),
    basis,
    gm: nested(o.gm, 'gm', 1) as CdWork['gm'],
    colJ: nested(o.colJ, 'colJ', 1) as CdWork['colJ'],
  };
}

/** The CD saves the work in progress (version-checked). */
export async function saveCd(db: D1Database, user: SessionUser, ws: Workspace, periodRaw: string, body: Obj): Promise<{ version: number }> {
  if (!isCd(user, ws)) throw forbidden();
  const period = parseMonth(periodRaw, 'period');
  const c = await requireCycle(db, ws, period);
  if (c.cd_status !== 'with_cd') throw conflict('the target is not with the Commercial Director');
  if (body.version !== c.version) throw new ApiError(409, { error: 'stale' });
  const work = parseCdWork(body.cd);
  const res = await writeBatch(db, [updateCycle(db, ws, period, c.version, 'cd_json = ?', [JSON.stringify(work)])], 'conflict');
  checkApplied(res);
  return { version: c.version + 1 };
}

export async function returnFromCd(db: D1Database, user: SessionUser, ws: Workspace, periodRaw: string, body: Obj): Promise<void> {
  if (!isCd(user, ws)) throw forbidden();
  const period = parseMonth(periodRaw, 'period');
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) : '';
  if (!comment) throw bad('a comment is required to return the target');
  const c = await requireCycle(db, ws, period);
  if (c.cd_status !== 'with_cd') throw conflict('the target is not with the Commercial Director');
  const res = await writeBatch(db, [
    updateCycle(db, ws, period, c.version, `cd_status = 'returned', cd_comment = ?`, [comment]),
    auditStatement(db, user.id, 'cycle.cd_return', {}, { ws, period, comment }),
    notifySql(db, ADMINS, [], 'cd_returned',
      txt(`The Commercial Director returned the ${period} target: ${comment}`, `أعاد المدير التجاري هدف ${period}: ${comment}`), `/admin/cycle/${ws}/${period}`),
  ], 'conflict');
  checkApplied(res);
}

export { cdFinal, cdSubmitProblems, type PackCat };

async function packCategories(db: D1Database): Promise<PackCat> {
  const rows = await all<{ code: string; grp: string }>(db, `SELECT code, grp FROM packs`);
  return new Map(rows.map((r) => [r.code, r.grp]));
}

export async function submitCd(db: D1Database, user: SessionUser, ws: Workspace, periodRaw: string): Promise<{ dept: Record<string, Record<string, number>> }> {
  if (!isCd(user, ws)) throw forbidden();
  const period = parseMonth(periodRaw, 'period');
  const c = await requireCycle(db, ws, period);
  if (c.cd_status !== 'with_cd') throw conflict('the target is not with the Commercial Director');
  const work = parseJson<CdWork>(c.cd_json);
  if (!work) throw conflict('there is nothing to submit');
  const depts = (await all<{ id: number }>(db, `SELECT id FROM departments WHERE workspace = ? ORDER BY id`, ws)).map((d) => String(d.id));
  const cats = await packCategories(db);
  const problems = cdSubmitProblems(work, cats, depts);
  if (problems.length) throw new ApiError(400, { error: 'invalid_request', detail: problems.join('; ') });
  const dept = cdFinal(work, cats, depts);
  const res = await writeBatch(db, [
    updateCycle(db, ws, period, c.version, `cd_status = 'submitted', cd_comment = NULL, dept_json = ?`, [JSON.stringify(dept)]),
    auditStatement(db, user.id, 'cycle.cd_submit', {}, { ws, period }),
    notifySql(db, ADMINS, [], 'cd_submitted',
      txt(`The Commercial Director submitted the ${period} split. You can calculate the route targets.`,
        `أرسل المدير التجاري توزيع ${period}. يمكنك حساب أهداف المسارات.`), `/admin/cycle/${ws}/${period}`),
  ], 'conflict');
  checkApplied(res);
  return { dept };
}

/** CD step off: Admin sets the department target directly (Pack rows x department). */
export async function setDeptTarget(db: D1Database, actorId: number, ws: Workspace, periodRaw: string, body: Obj): Promise<void> {
  const period = parseMonth(periodRaw, 'period');
  const c = await requireCycle(db, ws, period);
  const settings = parseJson<CycleSettings>(c.settings_json) ?? defaultSettings(period);
  if (settings.cdStep) throw conflict('the Commercial Director step is on: the department target comes from the CD');
  const raw = body.dept;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('dept must be an object of department id to packs');
  const ids = new Set((await all<{ id: number }>(db, `SELECT id FROM departments WHERE workspace = ?`, ws)).map((d) => String(d.id)));
  const dept: Record<string, Record<string, number>> = {};
  for (const [k, g] of Object.entries(raw as Obj)) {
    if (!ids.has(k)) throw bad(`department ${k} is not in this workspace`);
    dept[k] = packGrid(g, `dept ${k}`);
  }
  const res = await writeBatch(db, [
    updateCycle(db, ws, period, c.version, 'dept_json = ?', [JSON.stringify(dept)]),
    auditStatement(db, actorId, 'cycle.dept_target', {}, { ws, period }),
  ], 'conflict');
  checkApplied(res);
}

// ---------- Admin: calculate and apply (section 6, step D) ----------

/**
 * Stores the calculated route targets. Departments already sent (pending or
 * approved) keep their stored calculation. Each department's routes must add
 * up exactly to its department target per pack, and be routes of that
 * department.
 */
export async function applyCalc(db: D1Database, actorId: number, ws: Workspace, periodRaw: string, body: Obj): Promise<{ applied: string[]; kept: string[] }> {
  const period = parseMonth(periodRaw, 'period');
  const c = await requireCycle(db, ws, period);
  const dept = parseJson<Record<string, Record<string, number>>>(c.dept_json);
  if (!dept) throw conflict('there is no department target yet (the CD split, or the uploaded department target)');
  const raw = body.calc;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('calc must be an object');
  const locked = new Set((await all<{ dept_id: number }>(db,
    `SELECT h.dept_id FROM head_approvals h JOIN departments d ON d.id = h.dept_id
     WHERE h.period = ? AND d.workspace = ? AND h.status IN ('pending', 'approved')`, period, ws)).map((r) => String(r.dept_id)));
  const routesOf = new Map<string, Set<string>>();
  for (const l of await all<{ dept_id: number; route_code: string }>(db,
    `SELECT l.dept_id, l.route_code FROM leaves l JOIN departments d ON d.id = l.dept_id WHERE d.workspace = ?`, ws)) {
    const k = String(l.dept_id);
    if (!routesOf.has(k)) routesOf.set(k, new Set());
    routesOf.get(k)!.add(l.route_code);
  }
  const stored = (await one<{ calc_json: string | null }>(db, `SELECT calc_json FROM cycles WHERE ws = ? AND period = ?`, ws, period))?.calc_json;
  const next: Record<string, unknown> = parseJson<Record<string, unknown>>(stored ?? null) ?? {};
  const applied: string[] = [];
  const kept: string[] = [];
  for (const [d, routes] of Object.entries(raw as Obj)) {
    if (!(d in dept)) throw bad(`department ${d} has no department target`);
    if (locked.has(d)) { kept.push(d); continue; }
    if (!routes || typeof routes !== 'object' || Array.isArray(routes)) throw bad(`calc.${d} must be an object of route to packs`);
    const known = routesOf.get(d) ?? new Set<string>();
    const sums: Record<string, number> = {};
    for (const [r, g] of Object.entries(routes as Obj)) {
      if (!known.has(r)) throw bad(`route ${r} is not a route of department ${d}`);
      for (const [p, n] of Object.entries(packGrid(g, `calc.${d}.${r}`))) sums[p] = (sums[p] ?? 0) + n;
    }
    const target = dept[d]!;
    for (const p of new Set([...Object.keys(target), ...Object.keys(sums)])) {
      if ((sums[p] ?? 0) !== (target[p] ?? 0)) throw bad(`department ${d}: routes of ${p} add up to ${sums[p] ?? 0}, not the department target ${target[p] ?? 0}`);
    }
    next[d] = routes;
    applied.push(d);
  }
  const json = JSON.stringify(next);
  if (json.length > MAX_CALC_JSON) throw new ApiError(413, { error: 'too_many_rows', detail: 'the calculation is too large' });
  const notes = body.notes === undefined ? null : JSON.stringify(body.notes).slice(0, 20000);
  const res = await writeBatch(db, [
    updateCycle(db, ws, period, c.version, 'calc_json = ?, calc_notes = COALESCE(?, calc_notes)', [json, notes]),
    auditStatement(db, actorId, 'cycle.calc_apply', {}, { ws, period, applied, kept }),
  ], 'conflict');
  checkApplied(res);
  return { applied, kept };
}

// ---------- Admin -> Head of Department (sections 3 and 7) ----------

async function deptOfWs(db: D1Database, ws: Workspace, deptId: number): Promise<{ id: number; name: string }> {
  const d = await one<{ id: number; name: string }>(db, `SELECT id, name FROM departments WHERE id = ? AND workspace = ?`, deptId, ws);
  if (!d) throw notFound();
  return d;
}

/**
 * Sends the calculated target of one department to its Head: opens the month
 * when needed, loads every route of the department into it (the full grid,
 * missing packs = 0, salesman ID from the latest previous target), and marks
 * the Head's approval pending.
 */
export async function sendToHead(db: D1Database, actorId: number, ws: Workspace, periodRaw: string, deptId: number): Promise<{ monthId: number }> {
  const period = parseMonth(periodRaw, 'period');
  await deptOfWs(db, ws, deptId);
  const c = await requireCycle(db, ws, period);
  const settings = parseJson<CycleSettings>(c.settings_json) ?? defaultSettings(period);
  if (settings.cdStep && c.cd_status !== 'submitted') throw conflict('the Commercial Director has not submitted the split yet');
  const head = await one<{ status: HeadStatus }>(db, `SELECT status FROM head_approvals WHERE period = ? AND dept_id = ?`, period, deptId);
  if (head && (head.status === 'pending' || head.status === 'approved')) throw conflict(`already ${head.status}: restart the channel first`);
  const calcRow = await one<{ j: string | null }>(db,
    `SELECT json_extract(calc_json, '$."' || ? || '"') AS j FROM cycles WHERE ws = ? AND period = ?`, String(deptId), ws, period);
  const calc = parseJson<Record<string, Record<string, number>>>(calcRow?.j ?? null);
  if (!calc) throw conflict('calculate and apply the route targets for this department first');

  let m = await one<{ id: number; packs_json: string }>(db, `SELECT id, packs_json FROM months WHERE period = ?`, period);
  if (!m) {
    await createMonth(db, actorId, { period, deadline: settings.deadlines.supervisor });
    m = await one<{ id: number; packs_json: string }>(db, `SELECT id, packs_json FROM months WHERE period = ?`, period);
    if (!m) throw conflict('the month could not be opened');
  }
  const state = await one<{ state: string }>(db, `SELECT state FROM month_depts WHERE month_id = ? AND dept_id = ?`, m.id, deptId);
  if (state && state.state !== 'loading') throw conflict('this department is already running in the month: restart the channel first');
  // A clean slate for this department (earlier send, returned target) with the live tree.
  await resetDept(db, actorId, m.id, deptId);

  const codes = (JSON.parse(m.packs_json) as { code: string }[]).map((p) => p.code);
  const codeSet = new Set(codes);
  const leaves = await all<{ id: number; node_id: number; route_code: string; delivery_system: string }>(db,
    `SELECT l.id, l.node_id, l.route_code, l.delivery_system FROM leaves l
     WHERE l.dept_id = ? AND EXISTS (SELECT 1 FROM month_nodes mn WHERE mn.month_id = ? AND mn.node_id = l.node_id)`, deptId, m.id);
  if (leaves.length === 0) throw conflict('this department has no routes in the hierarchy');
  const byRoute = new Map(leaves.map((l) => [l.route_code, l]));
  for (const [r, g] of Object.entries(calc)) {
    if (!byRoute.has(r)) throw conflict(`route ${r} is no longer in this department's hierarchy: recalculate`);
    for (const [p, n] of Object.entries(g)) if (n > 0 && !codeSet.has(p)) throw conflict(`pack ${p} is not active in the month ${period}`);
  }
  const cats = await packCategories(db);
  const byCat: Record<string, number> = {};
  let total = 0;
  const rows = leaves.map((l) => {
    const g = calc[l.route_code] ?? {};
    const values: Record<string, number> = {};
    for (const p of codes) {
      const n = g[p] ?? 0;
      values[p] = n;
      total += n;
      const cat = cats.get(p) ?? 'Other';
      byCat[cat] = (byCat[cat] ?? 0) + n;
    }
    return { leaf_id: l.id, node_id: l.node_id, delivery_system: l.delivery_system, route_code: l.route_code, values_json: JSON.stringify(values) };
  });
  const now = new Date().toISOString();
  const fileId = `(SELECT MAX(id) FROM month_files WHERE month_id = ? AND dept_id = ?)`;
  await writeBatch(db, [
    db.prepare(`INSERT INTO month_files(month_id, dept_id, name, sheet1_json, uploaded_by, uploaded_at) VALUES (?, ?, ?, NULL, ?, ?)`)
      .bind(m.id, deptId, `Calculated target ${period}`, actorId, now),
    db.prepare(
      `INSERT INTO month_leaves(month_id, leaf_id, node_id, dept_id, file_id, delivery_system, route_code, salesman_id, values_json)
       SELECT ?, json_extract(value, '$.leaf_id'), json_extract(value, '$.node_id'), ?, ${fileId},
              json_extract(value, '$.delivery_system'), json_extract(value, '$.route_code'),
              (SELECT json_extract(dr.extra_json, '$.salesmanId') FROM data_routes dr
                WHERE dr.ws = ? AND dr.kind = 'prev_target' AND dr.route_code = json_extract(value, '$.route_code')
                ORDER BY dr.month DESC LIMIT 1),
              json_extract(value, '$.values_json')
       FROM json_each(?) WHERE true`,
    ).bind(m.id, deptId, m.id, deptId, ws, JSON.stringify(rows)),
    db.prepare(
      `INSERT INTO head_approvals(period, dept_id, status, sent_total, sent_json, sent_at, decided_at, comment)
       VALUES (?, ?, 'pending', ?, ?, ?, NULL, NULL)
       ON CONFLICT(period, dept_id) DO UPDATE SET status = 'pending', sent_total = excluded.sent_total, sent_json = excluded.sent_json,
         sent_at = excluded.sent_at, decided_at = NULL, comment = NULL`,
    ).bind(period, deptId, total, JSON.stringify(byCat), now),
    auditStatement(db, actorId, 'cycle.head_send', { monthId: m.id }, { ws, period, deptId, total }),
    notifySql(db, `SELECT manager_user_id FROM nodes WHERE dept_id = ? AND parent_id IS NULL`, [deptId], 'head_sent',
      txt(`Your ${period} target (${total.toLocaleString('en-US')} cases) is waiting for your approval. Due: ${settings.deadlines.head ?? '-'}.`,
        `هدف ${period} (${total.toLocaleString('en-US')} صندوق) بانتظار موافقتك. الموعد: ${settings.deadlines.head ?? '-'}.`),
      `/approve/${ws}/${period}`),
  ], 'conflict');
  return { monthId: m.id };
}

async function headContext(db: D1Database, user: SessionUser, ws: Workspace, period: string, deptId: number) {
  await deptOfWs(db, ws, deptId);
  const h = await one<{ status: HeadStatus; root_manager: number | null; month_id: number | null }>(db,
    `SELECT h.status, (SELECT manager_user_id FROM nodes WHERE dept_id = h.dept_id AND parent_id IS NULL) AS root_manager,
            (SELECT id FROM months WHERE period = h.period) AS month_id
     FROM head_approvals h WHERE h.period = ? AND h.dept_id = ?`, period, deptId);
  if (!h) throw notFound();
  if (h.root_manager !== user.id) throw forbidden();
  if (h.status !== 'pending') throw conflict(`the target is ${h.status}`);
  return h;
}

/** Head approves: the department starts and the Head's own split opens. */
export async function approveHead(db: D1Database, env: Env, user: SessionUser, ws: Workspace, periodRaw: string, deptId: number): Promise<void> {
  const period = parseMonth(periodRaw, 'period');
  const h = await headContext(db, user, ws, period, deptId);
  if (!h.month_id) throw conflict('the month is not open');
  await startDept(db, env, user.id, h.month_id, deptId);
  await writeBatch(db, [
    db.prepare(`UPDATE head_approvals SET status = 'approved', decided_at = ? WHERE period = ? AND dept_id = ? AND status = 'pending'`)
      .bind(new Date().toISOString(), period, deptId),
    auditStatement(db, user.id, 'cycle.head_approve', { monthId: h.month_id }, { ws, period, deptId }),
    notifySql(db, ADMINS, [], 'head_approved',
      txt(`${user.name} approved the ${period} target.`, `وافق ${user.name} على هدف ${period}.`), `/admin/cycle/${ws}/${period}`),
  ], 'conflict');
}

/** Head returns the target to Admin with a comment. */
export async function returnHead(db: D1Database, user: SessionUser, ws: Workspace, periodRaw: string, deptId: number, body: Obj): Promise<void> {
  const period = parseMonth(periodRaw, 'period');
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) : '';
  if (!comment) throw bad('a comment is required to return the target');
  const h = await headContext(db, user, ws, period, deptId);
  await writeBatch(db, [
    db.prepare(`UPDATE head_approvals SET status = 'returned', decided_at = ?, comment = ? WHERE period = ? AND dept_id = ? AND status = 'pending'`)
      .bind(new Date().toISOString(), comment, period, deptId),
    auditStatement(db, user.id, 'cycle.head_return', { monthId: h.month_id ?? undefined }, { ws, period, deptId, comment }),
    notifySql(db, ADMINS, [], 'head_returned',
      txt(`${user.name} returned the ${period} target: ${comment}`, `أعاد ${user.name} هدف ${period}: ${comment}`), `/admin/cycle/${ws}/${period}`),
  ], 'conflict');
}

/** Admin › Control: restart a whole channel back to draft (clears the month's work for the department). */
export async function restartHead(db: D1Database, actorId: number, ws: Workspace, periodRaw: string, deptId: number): Promise<void> {
  const period = parseMonth(periodRaw, 'period');
  await deptOfWs(db, ws, deptId);
  const m = await one<{ id: number }>(db, `SELECT id FROM months WHERE period = ?`, period);
  if (m) await resetDept(db, actorId, m.id, deptId);
  await writeBatch(db, [
    db.prepare(`UPDATE head_approvals SET status = 'draft', decided_at = NULL, comment = NULL WHERE period = ? AND dept_id = ?`).bind(period, deptId),
    auditStatement(db, actorId, 'cycle.head_restart', { monthId: m?.id }, { ws, period, deptId }),
    notifySql(db, `SELECT manager_user_id FROM nodes WHERE dept_id = ? AND parent_id IS NULL`, [deptId], 'channel_restarted',
      txt(`Admin restarted the ${period} target. It will be sent again.`, `أعاد المسؤول تشغيل هدف ${period}، وسيُرسل من جديد.`), null),
  ], 'conflict');
}

/** Targets waiting for the signed-in Head's approval (any workspace). */
export async function myApprovals(db: D1Database, userId: number): Promise<{ ws: Workspace; period: string; deptId: number; deptName: string; status: HeadStatus; sentTotal: number | null; sentByCategory: Record<string, number> | null; sentAt: string | null; deadline: string | null; comment: string | null }[]> {
  const rows = await all<{ ws: Workspace; period: string; dept_id: number; dept_name: string; status: HeadStatus; sent_total: number | null; sent_json: string | null; sent_at: string | null; settings_json: string | null; comment: string | null }>(db,
    `SELECT d.workspace AS ws, h.period, h.dept_id, d.name AS dept_name, h.status, h.sent_total, h.sent_json, h.sent_at, h.comment,
            (SELECT settings_json FROM cycles c WHERE c.ws = d.workspace AND c.period = h.period) AS settings_json
     FROM head_approvals h JOIN departments d ON d.id = h.dept_id
     JOIN nodes r ON r.dept_id = d.id AND r.parent_id IS NULL
     WHERE r.manager_user_id = ? AND h.status <> 'draft'
     ORDER BY h.period DESC, d.sort, d.code`, userId);
  return rows.map((r) => ({
    ws: r.ws, period: r.period, deptId: r.dept_id, deptName: r.dept_name, status: r.status, sentTotal: r.sent_total,
    sentByCategory: parseJson<Record<string, number>>(r.sent_json), sentAt: r.sent_at,
    deadline: parseJson<CycleSettings>(r.settings_json)?.deadlines.head ?? null, comment: r.comment,
  }));
}
