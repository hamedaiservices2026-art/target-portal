// Admin data store for the 8-step start (handover section 4): route-level
// history (sales, previous targets) packed per route and month, and month-level
// data (New Target, AOP, full-year target, department & channel targets).
//
// The browser parses the Excel files and sends checked rows; reads are built
// as ONE JSON string by SQLite (json_group_array / json_group_object), so the
// Worker never parses the stored values (CPU budget, docs/decisions.md).
import type { Workspace } from '../auth';
import { all, insertJsonStatement, MAX_INSERT_ROWS, one } from '../db';
import { auditStatement } from './audit';
import { ApiError, bad, writeBatch, type Obj } from './masters';

export const ROUTE_KINDS = ['sales', 'prev_target'] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];
export const MONTH_KINDS = ['new_target', 'aop', 'fy_target', 'dept_channel', 'aop_dept', 'target_upload'] as const;
export type MonthKind = (typeof MONTH_KINDS)[number];

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_VALUE = 1_000_000_000;
/** Month-level JSON larger than this is refused (D1 values are limited to 2 MB). */
const MAX_MONTH_JSON = 1_500_000;

export function workspace(v: string | undefined): Workspace {
  if (v === 'ops' || v === 'ka') return v;
  throw new ApiError(404, { error: 'not_found' });
}

export function month(v: unknown, field = 'month'): string {
  if (typeof v !== 'string' || !MONTH_RE.test(v)) throw bad(`${field} must be YYYY-MM`);
  return v;
}

function routeKind(v: unknown): RouteKind {
  if (typeof v === 'string' && (ROUTE_KINDS as readonly string[]).includes(v)) return v as RouteKind;
  throw bad(`kind must be one of ${ROUTE_KINDS.join(', ')}`);
}

function monthKind(v: unknown): MonthKind {
  if (typeof v === 'string' && (MONTH_KINDS as readonly string[]).includes(v)) return v as MonthKind;
  throw bad(`kind must be one of ${MONTH_KINDS.join(', ')}`);
}

/** {pack: cases}: finite numbers >= 0 (sales may carry decimals; targets are rounded by the caller). */
function packValues(v: unknown, where: string): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`${where}: values must be an object of pack to cases`);
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Obj)) {
    if (!k || k.length > 100) throw bad(`${where}: bad pack name`);
    if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > MAX_VALUE) throw bad(`${where}: cases of ${k} must be a number`);
    out[k] = n;
  }
  return out;
}

/** Removes the given months of a route-level kind before a re-upload ("a month already loaded is replaced, others are kept"). */
export async function clearRouteMonths(db: D1Database, actorId: number, ws: Workspace, body: Obj): Promise<{ removed: number }> {
  const kind = routeKind(body.kind);
  if (!Array.isArray(body.months) || body.months.length === 0 || body.months.length > 60) throw bad('months must be a list of 1 to 60 months');
  const months = body.months.map((m) => month(m));
  const res = await writeBatch(db, [
    db.prepare(`DELETE FROM data_routes WHERE ws = ? AND kind = ? AND month IN (SELECT value FROM json_each(?))`).bind(ws, kind, JSON.stringify(months)),
    auditStatement(db, actorId, `data.${kind}.clear`, {}, { ws, months }),
  ], 'conflict');
  return { removed: res[0]!.meta.changes ?? 0 };
}

/** "Remove the previous data" before an upload: every month of one kind (route rows or month data). */
export async function clearAllData(db: D1Database, actorId: number, ws: Workspace, body: Obj): Promise<{ removed: number }> {
  const table = body.table === 'routes' ? 'data_routes' : 'data_months';
  const kind = table === 'data_routes' ? routeKind(body.kind) : monthKind(body.kind);
  const res = await writeBatch(db, [
    db.prepare(`DELETE FROM ${table} WHERE ws = ? AND kind = ?`).bind(ws, kind),
    auditStatement(db, actorId, `data.${kind}.clear_all`, {}, { ws }),
  ], 'conflict');
  return { removed: res[0]!.meta.changes ?? 0 };
}

/** Upserts up to 200 route rows: [{month, routeCode, values, extra?}]. */
export async function uploadRouteRows(db: D1Database, actorId: number, ws: Workspace, body: Obj): Promise<{ count: number }> {
  const kind = routeKind(body.kind);
  if (!Array.isArray(body.rows) || body.rows.length === 0) throw bad('rows must be a non-empty list');
  if (body.rows.length > MAX_INSERT_ROWS) throw new ApiError(413, { error: 'too_many_rows', detail: `at most ${MAX_INSERT_ROWS} rows per batch` });
  const seen = new Set<string>();
  const rows = body.rows.map((r, i) => {
    const o = r as Obj;
    const where = `row ${i + 1}`;
    const m = month(o?.month, `${where} month`);
    if (typeof o.routeCode !== 'string' || !o.routeCode.trim() || o.routeCode.length > 100) throw bad(`${where}: routeCode is required`);
    const code = o.routeCode.trim();
    const key = `${m}|${code}`;
    if (seen.has(key)) throw bad(`${where}: route ${code} appears twice for ${m}`);
    seen.add(key);
    let extra: string | null = null;
    if (o.extra !== undefined && o.extra !== null) {
      if (typeof o.extra !== 'object' || Array.isArray(o.extra)) throw bad(`${where}: extra must be an object`);
      extra = JSON.stringify(o.extra);
      if (extra.length > 2000) throw bad(`${where}: extra is too long`);
    }
    return { ws, kind, month: m, route_code: code, extra_json: extra, values_json: JSON.stringify(packValues(o.values, where)) };
  });
  await writeBatch(db, [
    insertJsonStatement(db, 'data_routes', ['ws', 'kind', 'month', 'route_code', 'extra_json', 'values_json'], rows, {
      onConflict: `ON CONFLICT(ws, kind, month, route_code) DO UPDATE SET extra_json = excluded.extra_json, values_json = excluded.values_json`,
    }),
  ], 'conflict');
  return { count: rows.length };
}

/** Logs one audit row for a finished upload (the browser calls it after the last batch). */
export async function logUpload(db: D1Database, actorId: number, ws: Workspace, body: Obj): Promise<void> {
  const kind = typeof body.kind === 'string' ? body.kind.slice(0, 40) : 'unknown';
  const months = Array.isArray(body.months) ? body.months.filter((m) => typeof m === 'string').slice(0, 60) : [];
  const count = typeof body.count === 'number' ? body.count : null;
  const file = typeof body.file === 'string' ? body.file.slice(0, 200) : null;
  await auditStatement(db, actorId, `data.${kind}.upload`, {}, { ws, months, count, file }).run();
}

/** Route rows of one kind and month as one JSON array `[{r, v, x}]`, built by SQLite. */
export async function readRouteRows(db: D1Database, ws: Workspace, kindRaw: string | undefined, monthRaw: string | undefined): Promise<string> {
  const kind = routeKind(kindRaw);
  const m = month(monthRaw);
  const row = await one<{ j: string | null }>(db,
    `SELECT json_group_array(json_object('r', route_code, 'v', json(values_json), 'x', json(extra_json))) AS j
     FROM (SELECT route_code, values_json, extra_json FROM data_routes WHERE ws = ? AND kind = ? AND month = ? ORDER BY route_code)`,
    ws, kind, m);
  return row?.j ?? '[]';
}

/** Saves one month-level dataset (replacing that month). */
export async function saveMonthData(db: D1Database, actorId: number, ws: Workspace, body: Obj): Promise<{ month: string }> {
  const kind = monthKind(body.kind);
  const m = month(body.month);
  const v = body.values;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('values must be an object');
  const json = JSON.stringify(v);
  if (json.length > MAX_MONTH_JSON) throw new ApiError(413, { error: 'too_many_rows', detail: 'the month data is too large' });
  await writeBatch(db, [
    db.prepare(
      `INSERT INTO data_months(ws, kind, month, values_json, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ws, kind, month) DO UPDATE SET values_json = excluded.values_json, uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at`,
    ).bind(ws, kind, m, json, actorId, new Date().toISOString()),
    auditStatement(db, actorId, `data.${kind}.upload`, {}, { ws, month: m }),
  ], 'conflict');
  return { month: m };
}

/** Every month of a month-level kind as one JSON object `{month: values}`, built by SQLite. */
export async function readMonthData(db: D1Database, ws: Workspace, kindRaw: string | undefined): Promise<string> {
  const kind = monthKind(kindRaw);
  const row = await one<{ j: string | null }>(db,
    `SELECT json_group_object(month, json(values_json)) AS j FROM data_months WHERE ws = ? AND kind = ?`, ws, kind);
  return row?.j ?? '{}';
}

export type DataStatus = { kind: string; month: string; rows: number; uploadedAt: string | null }[];

/** What is loaded: route rows per kind and month, and the month-level datasets. */
export async function dataStatus(db: D1Database, ws: Workspace): Promise<DataStatus> {
  const routes = await all<{ kind: string; month: string; rows: number }>(db,
    `SELECT kind, month, COUNT(*) AS rows FROM data_routes WHERE ws = ? GROUP BY kind, month ORDER BY kind, month`, ws);
  const months = await all<{ kind: string; month: string; uploaded_at: string }>(db,
    `SELECT kind, month, uploaded_at FROM data_months WHERE ws = ? ORDER BY kind, month`, ws);
  return [
    ...routes.map((r) => ({ kind: r.kind, month: r.month, rows: r.rows, uploadedAt: null })),
    ...months.map((r) => ({ kind: r.kind, month: r.month, rows: 1, uploadedAt: r.uploaded_at })),
  ];
}

// ---------- organisation (for the CD, the calculator and the reports) ----------

export type OrgDto = {
  depts: { id: number; code: string; name: string; sort: number; channels: { channel: string; grp: string }[] }[];
  nodes: { id: number; deptId: number; parentId: number | null; name: string; managerUserId: number | null; managerName: string | null }[];
  leaves: { id: number; deptId: number; nodeId: number; routeCode: string; deliverySystem: string; label: string }[];
  packs: { code: string; grp: string; active: boolean; sort: number; sub?: string | null }[];
};

/** The live hierarchy of one workspace, with channels and the pack master. */
export async function readOrg(db: D1Database, ws: Workspace): Promise<OrgDto> {
  const res = await db.batch([
    db.prepare(`SELECT id, code, name, sort FROM departments WHERE workspace = ? ORDER BY sort, code`).bind(ws),
    db.prepare(`SELECT c.dept_id, c.channel, c.grp FROM dept_channels c JOIN departments d ON d.id = c.dept_id WHERE d.workspace = ? ORDER BY c.dept_id, c.sort, c.channel`).bind(ws),
    db.prepare(`SELECT n.id, n.dept_id, n.parent_id, n.name, n.manager_user_id, u.name AS manager_name FROM nodes n
                JOIN departments d ON d.id = n.dept_id LEFT JOIN users u ON u.id = n.manager_user_id
                WHERE d.workspace = ? ORDER BY n.name, n.id`).bind(ws),
    db.prepare(`SELECT l.id, l.dept_id, l.node_id, l.route_code, l.delivery_system, l.label FROM leaves l
                JOIN departments d ON d.id = l.dept_id WHERE d.workspace = ? ORDER BY l.route_code, l.id`).bind(ws),
    db.prepare(`SELECT code, grp, active, sort, sub FROM packs ORDER BY sort, code`),
  ]);
  const [depts, chans, nodes, leaves, packs] = res.map((r) => r.results as Obj[]);
  return {
    depts: depts!.map((d) => ({
      id: d.id as number, code: d.code as string, name: d.name as string, sort: d.sort as number,
      channels: chans!.filter((c) => c.dept_id === d.id).map((c) => ({ channel: c.channel as string, grp: c.grp as string })),
    })),
    nodes: nodes!.map((n) => ({
      id: n.id as number, deptId: n.dept_id as number, parentId: n.parent_id as number | null, name: n.name as string,
      managerUserId: n.manager_user_id as number | null, managerName: n.manager_name as string | null,
    })),
    leaves: leaves!.map((l) => ({
      id: l.id as number, deptId: l.dept_id as number, nodeId: l.node_id as number, routeCode: l.route_code as string,
      deliverySystem: l.delivery_system as string, label: l.label as string,
    })),
    packs: packs!.map((p) => ({ code: p.code as string, grp: p.grp as string, active: p.active === 1, sort: p.sort as number, sub: (p.sub as string | null) ?? null })),
  };
}

// ---------- channels per Head (Admin > Department & channel targets > Channels per Head) ----------

export async function setChannels(db: D1Database, actorId: number, deptId: number, body: Obj): Promise<{ channels: { channel: string; grp: string }[] }> {
  if (!Array.isArray(body.channels) || body.channels.length > 30) throw bad('channels must be a list of at most 30');
  const seen = new Set<string>();
  const channels = body.channels.map((c, i) => {
    const o = c as Obj;
    if (typeof o?.channel !== 'string' || !o.channel.trim() || o.channel.length > 60) throw bad(`channel ${i + 1} needs a name`);
    const name = o.channel.trim();
    if (seen.has(name.toLowerCase())) throw bad(`channel ${name} is listed twice`);
    seen.add(name.toLowerCase());
    const grp = typeof o.grp === 'string' ? o.grp.trim().slice(0, 30) : '';
    return { channel: name, grp, sort: i };
  });
  const dept = await one<{ id: number }>(db, `SELECT id FROM departments WHERE id = ?`, deptId);
  if (!dept) throw new ApiError(404, { error: 'not_found' });
  const before = await all<{ channel: string; grp: string }>(db, `SELECT channel, grp FROM dept_channels WHERE dept_id = ? ORDER BY sort, channel`, deptId);
  if (before.length === channels.length && before.every((b, i) => b.channel === channels[i]!.channel && b.grp === channels[i]!.grp)) {
    return { channels: channels.map(({ channel, grp }) => ({ channel, grp })) };
  }
  await writeBatch(db, [
    db.prepare(`DELETE FROM dept_channels WHERE dept_id = ?`).bind(deptId),
    ...(channels.length ? [db.prepare(
      `INSERT INTO dept_channels(dept_id, channel, grp, sort)
       SELECT ?, json_extract(value, '$.channel'), json_extract(value, '$.grp'), json_extract(value, '$.sort') FROM json_each(?)`,
    ).bind(deptId, JSON.stringify(channels))] : []),
    auditStatement(db, actorId, 'dept.channels', {}, { deptId, channels, before: before.map((b, i) => ({ ...b, sort: i })) }),
  ], 'a channel name is already used by another Head of Department');
  return { channels: channels.map(({ channel, grp }) => ({ channel, grp })) };
}

/** Workspace and order of a department (Admin > Departments). */
export async function setDeptWorkspace(db: D1Database, actorId: number, deptId: number, body: Obj): Promise<void> {
  const ws = body.workspace;
  if (ws !== 'ops' && ws !== 'ka') throw bad('workspace must be ops or ka');
  const sort = body.sort === undefined ? null : body.sort;
  if (sort !== null && (typeof sort !== 'number' || !Number.isInteger(sort))) throw bad('sort must be a whole number');
  const cur = await one<{ workspace: Workspace; sort: number }>(db, `SELECT workspace, sort FROM departments WHERE id = ?`, deptId);
  if (!cur) throw new ApiError(404, { error: 'not_found' });
  if (cur.workspace === ws && (sort === null || cur.sort === sort)) return;
  await writeBatch(db, [
    db.prepare(`UPDATE departments SET workspace = ?, sort = COALESCE(?, sort) WHERE id = ?`).bind(ws, sort, deptId),
    auditStatement(db, actorId, 'dept.workspace', {}, { deptId, workspace: ws, sort, before: { workspace: cur.workspace, sort: cur.sort } }),
  ], 'conflict');
}

// ---------- history of the Heads setup (Cycle setup > Heads of Department) ----------

export type SetupChange = {
  id: number; at: string; by: string | null; deptId: number; dept: string; kind: 'channels' | 'workspace';
  /** What it was before the change; null when the portal had not recorded it. */
  before: string | null; after: string; undoable: boolean;
};
type ChDetail = { deptId: number; channels: { channel: string; grp: string }[]; before?: { channel: string; grp: string }[] };
type WsDetail = { deptId: number; workspace: Workspace; sort: number | null; before?: { workspace: Workspace; sort: number } };
const chText = (l: { channel: string }[]) => l.map((c) => c.channel).join(', ') || '(none)';
const wsText = (w: Workspace, sort: number | null) => `${w === 'ka' ? 'Key Accounts' : 'Operations'}${sort === null ? '' : ` · order ${sort}`}`;

/**
 * The latest changes to the Heads' channels and workspace, each with what it
 * was before: the value saved with the change, else the previous change of the
 * same Head. Saving without a change is not listed (older saves were).
 */
export async function setupHistory(db: D1Database): Promise<{ changes: SetupChange[] }> {
  const rows = await all<{ id: number; at: string; action: string; detail_json: string; by: string | null }>(db,
    `SELECT a.id, a.at, a.action, a.detail_json, u.name AS by FROM audit a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.action IN ('dept.channels', 'dept.workspace') ORDER BY a.id`);
  const names = new Map((await all<{ id: number; name: string }>(db, `SELECT id, name FROM departments`)).map((d) => [d.id, d.name]));
  const lastCh = new Map<number, ChDetail['channels']>();
  const lastWs = new Map<number, { workspace: Workspace; sort: number | null }>();
  const out: SetupChange[] = [];
  for (const r of rows) {
    const base = { id: r.id, at: r.at, by: r.by };
    if (r.action === 'dept.channels') {
      const d = JSON.parse(r.detail_json) as ChDetail;
      const prev = d.before ?? lastCh.get(d.deptId) ?? null;
      lastCh.set(d.deptId, d.channels);
      if (prev && chText(prev) === chText(d.channels)) continue;
      out.push({ ...base, deptId: d.deptId, dept: names.get(d.deptId) ?? `#${d.deptId}`, kind: 'channels', before: prev ? chText(prev) : null, after: chText(d.channels), undoable: prev !== null });
    } else {
      const d = JSON.parse(r.detail_json) as WsDetail;
      const prev = d.before ?? lastWs.get(d.deptId) ?? null;
      lastWs.set(d.deptId, { workspace: d.workspace, sort: d.sort ?? prev?.sort ?? null });
      if (prev && prev.workspace === d.workspace && (d.sort === null || prev.sort === d.sort)) continue;
      out.push({ ...base, deptId: d.deptId, dept: names.get(d.deptId) ?? `#${d.deptId}`, kind: 'workspace', before: prev ? wsText(prev.workspace, prev.sort) : null, after: wsText(d.workspace, d.sort), undoable: prev !== null });
    }
  }
  return { changes: out.reverse().slice(0, 60) };
}

/** Puts back what a listed change replaced (it is itself recorded as a change). */
export async function undoSetupChange(db: D1Database, actorId: number, auditId: number): Promise<void> {
  const rows = await all<{ id: number; action: string; detail_json: string }>(db,
    `SELECT id, action, detail_json FROM audit WHERE action IN ('dept.channels', 'dept.workspace') AND id <= ? ORDER BY id`, auditId);
  const target = rows.find((r) => r.id === auditId);
  if (!target) throw new ApiError(404, { error: 'not_found' });
  const d = JSON.parse(target.detail_json) as ChDetail & WsDetail;
  const earlier = rows.filter((r) => r.id < auditId && r.action === target.action && (JSON.parse(r.detail_json) as { deptId: number }).deptId === d.deptId);
  const prevRow = earlier.length ? JSON.parse(earlier[earlier.length - 1]!.detail_json) as ChDetail & WsDetail : null;
  if (target.action === 'dept.channels') {
    const before = d.before ?? prevRow?.channels;
    if (!before) throw bad('what this Head had before this change was not recorded: type the channels again');
    await setChannels(db, actorId, d.deptId, { channels: before.map((c) => ({ channel: c.channel, grp: c.grp })) });
  } else {
    const before = d.before ?? (prevRow ? { workspace: prevRow.workspace, sort: prevRow.sort } : null);
    if (!before) throw bad('what this Head had before this change was not recorded: pick the workspace again');
    await setDeptWorkspace(db, actorId, d.deptId, { workspace: before.workspace, ...(before.sort === null || before.sort === undefined ? {} : { sort: before.sort }) });
  }
}

/** Commercial Director role per workspace (Admin > Users). */
export async function setCdRoles(db: D1Database, actorId: number, userId: number, body: Obj): Promise<{ cd: Workspace[] }> {
  if (!Array.isArray(body.cd) || body.cd.some((w) => w !== 'ops' && w !== 'ka')) throw bad('cd must be a list of ops / ka');
  const cd = [...new Set(body.cd as Workspace[])];
  const user = await one<{ id: number }>(db, `SELECT id FROM users WHERE id = ?`, userId);
  if (!user) throw new ApiError(404, { error: 'not_found' });
  await writeBatch(db, [
    db.prepare(`DELETE FROM user_roles WHERE user_id = ? AND role = 'cd'`).bind(userId),
    ...(cd.length ? [db.prepare(`INSERT INTO user_roles(user_id, role, workspace) SELECT ?, 'cd', value FROM json_each(?)`).bind(userId, JSON.stringify(cd))] : []),
    auditStatement(db, actorId, 'user.cd_roles', {}, { id: userId, cd }),
  ], 'conflict');
  return { cd };
}

export async function listCdRoles(db: D1Database): Promise<{ userId: number; workspace: Workspace }[]> {
  return all(db, `SELECT user_id AS userId, workspace FROM user_roles WHERE role = 'cd' ORDER BY user_id, workspace`);
}

// ---------- pack sub categories (pack mapping file) ----------

/** Pack -> {grp, sub} for every signed-in user (the distribution and summary screens group by them). */
export async function packSubs(db: D1Database): Promise<Record<string, { grp: string; sub: string | null }>> {
  const rows = await all<{ code: string; grp: string; sub: string | null }>(db, `SELECT code, grp, sub FROM packs ORDER BY sort, code`);
  return Object.fromEntries(rows.map((r) => [r.code, { grp: r.grp, sub: r.sub }]));
}

/** Sets the sub category of the packs listed (`{map: {code: sub}}`); packs not listed keep theirs. */
export async function setPackSubs(db: D1Database, actorId: number, body: Obj): Promise<{ updated: number }> {
  const raw = body.map;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('map must be an object of pack to sub category');
  const list = Object.entries(raw as Obj).map(([code, sub]) => {
    if (!code || code.length > 100) throw bad('bad pack code');
    if (sub !== null && (typeof sub !== 'string' || sub.trim().length > 40)) throw bad(`sub category of ${code} must be a text of at most 40 characters`);
    return { code, sub: typeof sub === 'string' && sub.trim() ? sub.trim() : null };
  });
  if (list.length > 2000) throw bad('at most 2000 packs at once');
  if (!list.length) return { updated: 0 };
  const res = await writeBatch(db, [
    db.prepare(
      `UPDATE packs SET sub = (SELECT json_extract(value, '$.sub') FROM json_each(?1) WHERE json_extract(value, '$.code') = packs.code)
       WHERE code IN (SELECT json_extract(value, '$.code') FROM json_each(?1))`,
    ).bind(JSON.stringify(list)),
    auditStatement(db, actorId, 'packs.sub', {}, { count: list.length }),
  ], 'conflict');
  return { updated: res[0]!.meta.changes ?? 0 };
}
