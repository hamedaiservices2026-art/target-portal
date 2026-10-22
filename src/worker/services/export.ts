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
//
// Paged: one request returns at most BACKUP_MAX_LIMIT rows of ONE table, in a
// fixed key order, with a `next` cursor. The History page stitches the pages.

type BackupTable = { select: string; key: string[] };

/** Every table except sessions, login_failures and import_passwords (transient staged hashes); users get explicit columns (no pw_hash / pw_salt). */
export const BACKUP_TABLES: Record<string, BackupTable> = {
  users: { select: 'SELECT id, username, name, email, role, lang, active FROM users', key: ['id'] },
  departments: { select: 'SELECT * FROM departments', key: ['id'] },
  packs: { select: 'SELECT * FROM packs', key: ['code'] },
  settings: { select: 'SELECT * FROM settings', key: ['key'] },
  nodes: { select: 'SELECT * FROM nodes', key: ['id'] },
  leaves: { select: 'SELECT * FROM leaves', key: ['id'] },
  months: { select: 'SELECT * FROM months', key: ['id'] },
  month_files: { select: 'SELECT * FROM month_files', key: ['id'] },
  month_depts: { select: 'SELECT * FROM month_depts', key: ['month_id', 'dept_id'] },
  month_nodes: { select: 'SELECT * FROM month_nodes', key: ['month_id', 'node_id'] },
  month_leaves: { select: 'SELECT * FROM month_leaves', key: ['month_id', 'leaf_id'] },
  audit: { select: 'SELECT * FROM audit', key: ['id'] },
  email_log: { select: 'SELECT * FROM email_log', key: ['id'] },
};

export const BACKUP_DEFAULT_LIMIT = 200;
export const BACKUP_MAX_LIMIT = 500;

export type BackupIndex = { exportedAt: string; limit: number; tables: { name: string; rows: number }[] };
export type BackupPage = { table: string; rows: Record<string, unknown>[]; next: string | number | (string | number)[] | null };

function cursorOf(raw: string | undefined, width: number): (string | number)[] | null {
  if (raw === undefined || raw === '') return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw bad('after is not a valid cursor'); }
  const parts = Array.isArray(v) ? v : [v];
  if (parts.length !== width || !parts.every((x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))) {
    throw bad('after is not a valid cursor for this table');
  }
  return parts as (string | number)[];
}

/** Table list with row counts (audited once: this is the start of a download). */
export async function backupIndex(db: D1Database, actorId: number): Promise<BackupIndex> {
  const names = Object.keys(BACKUP_TABLES);
  // One row of scalar subqueries (a UNION ALL of 13 terms exceeds D1's compound-select limit).
  const counts = await one<Record<string, number>>(
    db, `SELECT ${names.map((n) => `(SELECT COUNT(*) FROM ${n}) AS ${n}`).join(', ')}`) ?? {};
  await auditStatement(db, actorId, 'backup.download', {}, undefined).run();
  return {
    exportedAt: new Date().toISOString(),
    limit: BACKUP_MAX_LIMIT,
    tables: names.map((name) => ({ name, rows: counts[name] ?? 0 })),
  };
}

export async function backupPage(
  db: D1Database, q: { table: string; after?: string; limit?: string },
): Promise<BackupPage> {
  const def = Object.prototype.hasOwnProperty.call(BACKUP_TABLES, q.table) ? BACKUP_TABLES[q.table]! : null;
  if (!def) throw bad('unknown table');
  const limit = Math.min(posInt(q.limit, 'limit') ?? BACKUP_DEFAULT_LIMIT, BACKUP_MAX_LIMIT);
  const after = cursorOf(q.after, def.key.length);
  const keyList = def.key.join(', ');
  const rows = await all<Record<string, unknown>>(
    db,
    `SELECT * FROM (${def.select}) ${after ? `WHERE (${keyList}) > (${def.key.map(() => '?').join(', ')})` : ''}
     ORDER BY ${keyList} LIMIT ?`,
    ...(after ?? []), limit + 1,
  );
  const page = rows.slice(0, limit);
  let next: BackupPage['next'] = null;
  if (rows.length > limit) {
    const last = page[page.length - 1]!;
    const k = def.key.map((c) => last[c] as string | number);
    next = k.length === 1 ? k[0]! : k;
  }
  return { table: q.table, rows: page, next };
}
