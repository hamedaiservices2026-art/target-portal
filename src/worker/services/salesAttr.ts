// Sales attribution (Admin): the Modern Trade and Modern Bulk departments
// have no routes of their own in the sales file, so their sales show empty.
// The Admin picks people (a Key Account KAE, or a code of the Operation sales
// file that is in no hierarchy) and assigns each to a department and channel;
// their sales then count for that department and channel everywhere the
// department sales are used (splits, Mix, approval template, reports).
import { all, one } from '../db';
import { auditStatement } from './audit';
import { bad, writeBatch, type Obj } from './masters';

const KEY = 'sales_attr';
export type SalesAttr = { code: string; src: 'ops' | 'ka'; deptId: number; channel: string; name?: string };
/** The code a KA person's sales use in the Operation sales data (kept apart from Operation route codes). */
export const KA_PREFIX = 'KA:';

export async function getSalesAttr(db: D1Database): Promise<SalesAttr[]> {
  const r = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = ?`, KEY);
  if (!r) return [];
  try {
    const v = JSON.parse(r.value) as SalesAttr[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function setSalesAttr(db: D1Database, actorId: number, body: Obj): Promise<SalesAttr[]> {
  if (!Array.isArray(body.list) || body.list.length > 500) throw bad('list must be a list of at most 500');
  const depts = new Map((await all<{ id: number }>(db, `SELECT id FROM departments WHERE workspace = 'ops'`)).map((d) => [d.id, true]));
  const seen = new Set<string>();
  const list: SalesAttr[] = body.list.map((x, i) => {
    const o = x as Obj;
    const code = typeof o?.code === 'string' ? o.code.trim() : '';
    if (!code || code.length > 60 || code.includes('"')) throw bad(`line ${i + 1}: a code is needed`);
    const src = o.src === 'ka' ? 'ka' : 'ops';
    const k = `${src}:${code}`;
    if (seen.has(k)) throw bad(`${code} is listed twice`);
    seen.add(k);
    const deptId = Number(o.deptId);
    if (!depts.has(deptId)) throw bad(`line ${i + 1}: pick an Operation department`);
    const channel = typeof o.channel === 'string' ? o.channel.trim().slice(0, 60) : '';
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 120) : undefined;
    return { code, src, deptId, channel, ...(name ? { name } : {}) };
  });
  await writeBatch(db, [
    db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(KEY, JSON.stringify(list)),
    auditStatement(db, actorId, 'settings.sales_attr', {}, { n: list.length }),
  ], 'conflict');
  return list;
}

/** Operation sales of a month: the Key Account people assigned to an Operation department, as `KA:<code>` rows. */
export async function kaAttrRows(db: D1Database, month: string): Promise<string> {
  const codes = (await getSalesAttr(db)).filter((a) => a.src === 'ka').map((a) => a.code);
  if (!codes.length) return '[]';
  const row = await one<{ j: string | null }>(db,
    `SELECT json_group_array(json_object('r', ? || route_code, 'v', json(values_json), 'x', json(extra_json))) AS j
     FROM (SELECT route_code, values_json, extra_json FROM data_routes
           WHERE ws = 'ka' AND kind = 'sales' AND month = ? AND route_code IN (SELECT value FROM json_each(?)) ORDER BY route_code)`,
    KA_PREFIX, month, JSON.stringify(codes));
  return row?.j ?? '[]';
}

/** Codes in the Operation sales file that are in no Operation hierarchy (latest month with sales). */
export async function unmappedOpsCodes(db: D1Database): Promise<{ month: string | null; codes: string[] }> {
  const m = await one<{ month: string }>(db, `SELECT MAX(month) AS month FROM data_routes WHERE ws = 'ops' AND kind = 'sales'`);
  if (!m?.month) return { month: null, codes: [] };
  const rows = await all<{ route_code: string }>(db,
    `SELECT DISTINCT dr.route_code FROM data_routes dr
     WHERE dr.ws = 'ops' AND dr.kind = 'sales' AND dr.month = ?
       AND NOT EXISTS (SELECT 1 FROM leaves l JOIN departments d ON d.id = l.dept_id WHERE d.workspace = 'ops' AND l.route_code = dr.route_code)
     ORDER BY dr.route_code LIMIT 2000`, m.month);
  return { month: m.month, codes: rows.map((r) => r.route_code) };
}
