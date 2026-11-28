// Sales attribution (Admin): the Modern Trade and Modern Bulk channels have
// no routes of their own in the sales file, so their YAGO sales in the
// approval template are empty. The Admin picks people (a Key Account KAE, or a
// code of the Operation sales file that is in no hierarchy) and assigns each
// to a department and channel. Only the approval template's YAGO sales by
// channel use it: no other sales total (PAGO, splits, reports) changes.
import { all, one } from '../db';
import { auditStatement } from './audit';
import { bad, writeBatch, type Obj } from './masters';

const KEY = 'sales_attr';
export type SalesAttr = { code: string; src: 'ops' | 'ka'; deptId: number; channel: string; name?: string };

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

/**
 * The YAGO sales of the people assigned to a department and channel, for the
 * approval template only (no other sales total changes): one grid per person.
 */
export async function attrSales(db: D1Database, month: string): Promise<{ deptId: number; channel: string; v: Record<string, number> }[]> {
  const list = await getSalesAttr(db);
  if (!list.length) return [];
  const rows = await all<{ ws: string; route_code: string; values_json: string }>(db,
    `SELECT ws, route_code, values_json FROM data_routes
     WHERE kind = 'sales' AND month = ? AND ((ws = 'ka' AND route_code IN (SELECT value FROM json_each(?))) OR (ws = 'ops' AND route_code IN (SELECT value FROM json_each(?))))`,
    month, JSON.stringify(list.filter((a) => a.src === 'ka').map((a) => a.code)), JSON.stringify(list.filter((a) => a.src === 'ops').map((a) => a.code)));
  const by = new Map(rows.map((r) => [`${r.ws}:${r.route_code}`, r.values_json]));
  const out: { deptId: number; channel: string; v: Record<string, number> }[] = [];
  for (const a of list) {
    const j = by.get(`${a.src}:${a.code}`);
    if (!j) continue;
    try { out.push({ deptId: a.deptId, channel: a.channel, v: JSON.parse(j) as Record<string, number> }); } catch { /* skip */ }
  }
  return out;
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
