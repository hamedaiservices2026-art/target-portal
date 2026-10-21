// Export, audit history and backup. Read-only except for the audit rows that
// record an export and a backup download.
//
// D1 budget: the export grid is built by SQLite (json_each over the month's
// pack snapshot x month_leaves), so a ~30,000-value month is ONE statement and
// the Worker never parses per-leaf JSON.
import { all, batch, one } from '../db';
import { auditStatement } from './audit';
import { bad, notFound } from './masters';

export const EXPORT_COLUMNS = [
  'Period (YYYY-MM)', 'Delivery System', 'Route Code', 'Salesman ID', 'Sales Target Category', 'Cases',
] as const;

export type ExportResult = {
  columns: string[];
  rows: (string | number)[][];
  departments: { id: number; code: string; state: string }[];
};

/** Query-string `dept` for export: 'all' (null) or a positive id. */
export function exportDept(raw: string | undefined): number | null {
  if (raw === 'all') return null;
  if (raw === undefined || !/^[1-9][0-9]{0,14}$/.test(raw)) throw bad("dept must be a department id or 'all'");
  return Number(raw);
}

export async function exportMonth(db: D1Database, actorId: number, monthId: number, dept: number | null): Promise<ExportResult> {
  const m = await one<{ period: string }>(db, `SELECT period FROM months WHERE id = ?`, monthId);
  if (!m) throw notFound();
  const departments = await all<{ id: number; code: string; state: string }>(
    db,
    `SELECT d.id, d.code, md.state FROM month_depts md JOIN departments d ON d.id = md.dept_id
     WHERE md.month_id = ? ${dept === null ? '' : 'AND md.dept_id = ?'} ORDER BY d.id`,
    ...(dept === null ? [monthId] : [monthId, dept]),
  );
  if (dept !== null && departments.length === 0) throw notFound();

  // Every leaf x every snapshot pack (missing value -> 0). The value is looked
  // up by key, so odd pack codes need no path escaping.
  const rows = await all<{ ds: string; route: string; sman: string | null; pack: string; cases: number }>(
    db,
    `SELECT l.delivery_system AS ds, l.route_code AS route, l.salesman_id AS sman, p.code AS pack,
            COALESCE((SELECT v.value FROM json_each(l.values_json) v WHERE v.key = p.code), 0) AS cases
     FROM month_leaves l
     JOIN (SELECT CAST(key AS INTEGER) AS i, json_extract(value, '$.code') AS code
           FROM json_each((SELECT packs_json FROM months WHERE id = ?))) p
     WHERE l.month_id = ? ${dept === null ? '' : 'AND l.dept_id = ?'}
     ORDER BY l.file_id, l.route_code, l.leaf_id, p.i`,
    ...(dept === null ? [monthId, monthId] : [monthId, monthId, dept]),
  );
  await auditStatement(db, actorId, 'month.export', { monthId }, { dept: dept === null ? 'all' : dept, rows: rows.length }).run();
  return {
    columns: [...EXPORT_COLUMNS],
    rows: rows.map((r) => [m.period, r.ds, r.route, r.sman ?? '', r.pack, Math.round(Number(r.cases))]),
    departments,
  };
}

// ---------- audit history ----------

export type AuditRow = {
  id: number; at: string; userId: number | null; userName: string | null;
  action: string; monthId: number | null; nodeId: number | null; detail: unknown;
};

function posInt(raw: string | undefined, field: string): number | null {
  if (raw === undefined || raw === '') return null;
  if (!/^[1-9][0-9]{0,14}$/.test(raw)) throw bad(`${field} must be a positive integer`);
  return Number(raw);
}

export async function listAudit(
  db: D1Database,
  q: { month?: string; limit?: string; before?: string },
): Promise<{ rows: AuditRow[]; nextBefore: number | null }> {
  const month = posInt(q.month, 'month');
  const before = posInt(q.before, 'before');
  const limit = Math.min(posInt(q.limit, 'limit') ?? 100, 200);
  const where: string[] = [];
  const args: number[] = [];
  if (month !== null) { where.push('a.month_id = ?'); args.push(month); }
  if (before !== null) { where.push('a.id < ?'); args.push(before); }
  const res = await all<{
    id: number; at: string; user_id: number | null; user_name: string | null; action: string;
    month_id: number | null; node_id: number | null; detail_json: string | null;
  }>(
    db,
    `SELECT a.id, a.at, a.user_id, u.name AS user_name, a.action, a.month_id, a.node_id, a.detail_json
     FROM audit a LEFT JOIN users u ON u.id = a.user_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.id DESC LIMIT ?`,
    ...args, limit + 1,
  );
  const page = res.slice(0, limit);
  return {
    rows: page.map((r) => ({
      id: r.id, at: r.at, userId: r.user_id, userName: r.user_name, action: r.action,
      monthId: r.month_id, nodeId: r.node_id, detail: r.detail_json === null ? null : JSON.parse(r.detail_json),
    })),
    nextBefore: res.length > limit ? page[page.length - 1]!.id : null,
  };
}

// ---------- backup ----------

/** Every table except sessions and login_failures; users get explicit columns (no pw_hash / pw_salt). */
export const BACKUP_TABLES: Record<string, string> = {
  users: 'SELECT id, username, name, email, role, lang, active FROM users',
  departments: 'SELECT * FROM departments',
  packs: 'SELECT * FROM packs',
  settings: 'SELECT * FROM settings',
  nodes: 'SELECT * FROM nodes',
  leaves: 'SELECT * FROM leaves',
  months: 'SELECT * FROM months',
  month_files: 'SELECT * FROM month_files',
  month_depts: 'SELECT * FROM month_depts',
  month_nodes: 'SELECT * FROM month_nodes',
  month_leaves: 'SELECT * FROM month_leaves',
  audit: 'SELECT * FROM audit',
  email_log: 'SELECT * FROM email_log',
};

export async function backup(db: D1Database, actorId: number): Promise<Record<string, unknown>> {
  const names = Object.keys(BACKUP_TABLES);
  const results = await batch(db, names.map((n) => db.prepare(BACKUP_TABLES[n]!)));
  const out: Record<string, unknown> = { exportedAt: new Date().toISOString() };
  names.forEach((n, i) => { out[n] = results[i]!.results; });
  await auditStatement(db, actorId, 'backup.download', {}, undefined).run();
  return out;
}
