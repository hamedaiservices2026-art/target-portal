// Distribution page extras (handover section 7): benchmark columns per team
// member (average sales of the ticked months, PAGO and YAGO sales) and the
// supervisor's salesman ID correction.
//
// The sums run in SQLite (json_each over the packed sales rows) and come back
// as one JSON string, so the Worker never parses the sales grids.
import { addMonths } from '../../shared/calc/periods';
import type { SessionUser } from '../auth';
import { all, one } from '../db';
import { auditStatement } from './audit';
import { canView, loadDept } from './distribution';
import { bad, forbidden, notFound, writeBatch, type Obj } from './masters';
import { ADMINS, notifySql } from './notify';
import { childKeys, preorder } from './plan';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * `[[childKey, pack, avg, pago, yago], ...]` for the node's team members.
 * avg = average of the ticked months, skipping months with no sales (like
 * Excel AVERAGE); PAGO / YAGO = the sales of the month before / a year before
 * the target month (they do not change with the ticked months).
 */
export async function benchmarks(db: D1Database, user: SessionUser, monthId: number, nodeId: number, monthsRaw: string | undefined): Promise<string> {
  const { d } = await loadDept(db, monthId, nodeId, 'subtree');
  if (!canView(d, user, nodeId)) throw forbidden();
  const months = (monthsRaw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (months.length > 24 || months.some((m) => !MONTH_RE.test(m))) throw bad('months must be up to 24 months as YYYY-MM');
  const pago = addMonths(d.month.period, -1);
  const yago = addMonths(d.month.period, -12);
  const map: [string, string][] = [];
  for (const key of childKeys(d, nodeId)) {
    const id = Number(key.slice(2));
    if (key.startsWith('l:')) {
      const leaf = d.leaves.find((l) => l.leaf_id === id);
      if (leaf) map.push([leaf.route_code, key]);
    } else {
      for (const n of preorder(d, id)) for (const l of d.leavesByNode.get(n) ?? []) map.push([l.route_code, key]);
    }
  }
  const ws = (await one<{ workspace: string }>(db, `SELECT workspace FROM departments WHERE id = ?`, d.deptId))?.workspace ?? 'ops';
  const all3 = [...new Set([...months, pago, yago])];
  const row = await one<{ j: string | null }>(db,
    `WITH m(route, child) AS MATERIALIZED (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)),
          s AS (SELECT m.child, dr.month, je.key AS pack, SUM(je.value) AS v
                FROM data_routes dr JOIN m ON m.route = dr.route_code, json_each(dr.values_json) je
                WHERE dr.ws = ? AND dr.kind = 'sales' AND dr.month IN (SELECT value FROM json_each(?))
                GROUP BY m.child, dr.month, je.key),
          a AS (SELECT child, pack,
                  AVG(CASE WHEN month IN (SELECT value FROM json_each(?)) THEN v END) AS avg,
                  SUM(CASE WHEN month = ? THEN v END) AS pago,
                  SUM(CASE WHEN month = ? THEN v END) AS yago
                FROM s GROUP BY child, pack)
     SELECT json_group_array(json_array(child, pack, avg, pago, yago)) AS j FROM a`,
    JSON.stringify(map), ws, JSON.stringify(all3), JSON.stringify(months), pago, yago);
  return row?.j ?? '[]';
}

/** Months that have sales in a workspace (the month picker greys the others). */
export async function salesMonths(db: D1Database, ws: string): Promise<string[]> {
  return (await all<{ month: string }>(db, `SELECT DISTINCT month FROM data_routes WHERE ws = ? AND kind = 'sales' ORDER BY month`, ws)).map((r) => r.month);
}

/** Supervisor extra: correct the salesman ID of one of their routes in the month; Admin is notified. */
export async function setSalesman(db: D1Database, user: SessionUser, monthId: number, leafId: number, body: Obj): Promise<{ salesmanId: string | null }> {
  const raw = body.salesmanId;
  if (raw !== null && (typeof raw !== 'string' || raw.length > 100)) throw bad('salesmanId must be a text of at most 100 characters');
  const salesmanId = typeof raw === 'string' ? raw.trim() || null : null;
  const l = await one<{ route_code: string; salesman_id: string | null; manager_user_id: number | null; period: string }>(db,
    `SELECT ml.route_code, ml.salesman_id, mn.manager_user_id, m.period FROM month_leaves ml
     JOIN month_nodes mn ON mn.month_id = ml.month_id AND mn.node_id = ml.node_id JOIN months m ON m.id = ml.month_id
     WHERE ml.month_id = ? AND ml.leaf_id = ?`, monthId, leafId);
  if (!l) throw notFound();
  if (l.manager_user_id !== user.id && user.role !== 'admin') throw forbidden();
  if (l.salesman_id === salesmanId) return { salesmanId };
  await writeBatch(db, [
    db.prepare(`UPDATE month_leaves SET salesman_id = ? WHERE month_id = ? AND leaf_id = ?`).bind(salesmanId, monthId, leafId),
    auditStatement(db, user.id, 'leaf.salesman', { monthId }, { leafId, route: l.route_code, from: l.salesman_id, to: salesmanId }),
    notifySql(db, ADMINS, [], 'salesman_changed', {
      en: `${user.name} changed the salesman ID of route ${l.route_code} (${l.period}) from ${l.salesman_id ?? '-'} to ${salesmanId ?? '-'}.`,
      ar: `غيّر ${user.name} رقم المندوب للمسار ${l.route_code} (${l.period}) من ${l.salesman_id ?? '-'} إلى ${salesmanId ?? '-'}.`,
    }, null),
  ], 'conflict');
  return { salesmanId };
}
