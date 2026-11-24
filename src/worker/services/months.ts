// Months: opening a cycle, receiving the checked forecast in batches, resetting
// and starting a department. Same conventions as masters.ts / hierarchy.ts:
// validation here, every write is ONE db.batch() (change + audit, atomic).
//
// D1 budget: month creation copies the live tree with ONE statement per table
// (INSERT ... SELECT), a forecast batch is ONE json_each statement, reset is
// four set-based statements. Nothing here is per row.
import type { LeafGrid } from '../../shared/forecast';
import type { Env } from '../index';
import { all, insertJsonStatement, MAX_INSERT_ROWS, one } from '../db';
import { auditStatement } from './audit';
import { openTurn } from './distribution';
import { ApiError, bad, int, notFound, text, writeBatch, type Obj } from './masters';

const MAX_VALUE = 1_000_000_000;
const MAX_REPORTED = 50;

export type MonthPack = { code: string; grp: string; sort: number };

const conflict = (detail: string, leafIds?: number[]) =>
  new ApiError(409, { error: 'conflict', detail, ...(leafIds ? { leafIds } : {}) });

// ---------- parsers ----------

function period(v: unknown): string {
  const s = text(v, 'period', 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw bad('period must look like YYYY-MM');
  return s;
}

/** Optional ISO calendar date; null/undefined/'' means none. */
function deadline(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('deadline must look like YYYY-MM-DD');
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad('deadline is not a real date');
  return v;
}

function positive(v: unknown, field: string): number {
  const n = int(v, field);
  if (n < 1) throw bad(`${field} must be a positive integer`);
  return n;
}

/** Query-string `dept`, required. */
export function requiredDept(raw: string | undefined): number {
  if (raw === undefined || !/^[1-9][0-9]{0,14}$/.test(raw)) throw bad('dept must be a positive integer');
  return Number(raw);
}

// ---------- lookups ----------

type MonthRow = { id: number; period: string; deadline: string | null; packs_json: string; created_at: string };

async function getMonth(db: D1Database, id: number): Promise<MonthRow> {
  const m = await one<MonthRow>(db, `SELECT id, period, deadline, packs_json, created_at FROM months WHERE id = ?`, id);
  if (!m) throw notFound();
  return m;
}

const packsOf = (m: { packs_json: string }): MonthPack[] => JSON.parse(m.packs_json) as MonthPack[];

async function getMonthDept(db: D1Database, monthId: number, deptId: number): Promise<string> {
  const r = await one<{ state: string }>(db, `SELECT state FROM month_depts WHERE month_id = ? AND dept_id = ?`, monthId, deptId);
  if (!r) throw notFound();
  return r.state;
}

// ---------- months ----------

export type MonthDto = { id: number; period: string; deadline: string | null; createdAt: string };

export async function createMonth(db: D1Database, actorId: number, body: Obj): Promise<MonthDto> {
  const per = period(body.period);
  const dl = deadline(body.deadline);
  const active = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM packs WHERE active = 1`);
  if (!active || active.n === 0) throw bad('there are no active packs to open a month with');
  const now = new Date().toISOString();

  const [ins] = await writeBatch(db, [
    // The pack snapshot is built inside the INSERT, so it is the packs as of this transaction.
    db.prepare(
      `INSERT INTO months(period, deadline, packs_json, created_at)
       VALUES (?, ?, (SELECT json_group_array(json_object('code', code, 'grp', grp, 'sort', sort))
                      FROM (SELECT code, grp, sort FROM packs WHERE active = 1 ORDER BY sort, code)), ?)
       RETURNING id, period, deadline, created_at AS createdAt`,
    ).bind(per, dl, now),
    db.prepare(
      `INSERT INTO month_nodes(month_id, node_id, dept_id, parent_id, name, manager_user_id, status, version)
       SELECT (SELECT id FROM months WHERE period = ?), id, dept_id, parent_id, name, manager_user_id, 'waiting', 0
       FROM nodes`,
    ).bind(per),
    db.prepare(
      `INSERT INTO month_depts(month_id, dept_id, state)
       SELECT (SELECT id FROM months WHERE period = ?), id, 'loading' FROM departments`,
    ).bind(per),
    db.prepare(
      `INSERT INTO audit(at, user_id, action, month_id, node_id, detail_json)
       SELECT ?, ?, 'month.create', id, NULL, ? FROM months WHERE period = ?`,
    ).bind(now, actorId, JSON.stringify({ period: per, deadline: dl }), per),
  ], 'a month for this period already exists');
  return ins!.results[0] as MonthDto;
}

export async function updateMonth(db: D1Database, actorId: number, id: number, body: Obj): Promise<MonthDto> {
  if (body.deadline === undefined) throw bad('deadline is required (null to clear it)');
  const dl = deadline(body.deadline);
  const m = await getMonth(db, id);
  if (m.deadline !== dl) {
    await writeBatch(db, [
      db.prepare(`UPDATE months SET deadline = ? WHERE id = ?`).bind(dl, id),
      auditStatement(db, actorId, 'month.update', { monthId: id }, { deadline: { from: m.deadline, to: dl } }),
    ], 'conflict');
  }
  return { id, period: m.period, deadline: dl, createdAt: m.created_at };
}

export type MonthListDto = MonthDto & {
  depts: { deptId: number; code: string; name: string; state: string; files: number; leaves: number }[];
};

export async function listMonths(db: D1Database): Promise<MonthListDto[]> {
  const months = await all<MonthDto>(
    db, `SELECT id, period, deadline, created_at AS createdAt FROM months ORDER BY period DESC`);
  const depts = await all<{ month_id: number; deptId: number; code: string; name: string; state: string; files: number; leaves: number }>(
    db,
    `SELECT md.month_id, md.dept_id AS deptId, d.code, d.name, md.state,
            (SELECT COUNT(*) FROM month_files f WHERE f.month_id = md.month_id AND f.dept_id = md.dept_id) AS files,
            (SELECT COUNT(*) FROM month_leaves l WHERE l.month_id = md.month_id AND l.dept_id = md.dept_id) AS leaves
     FROM month_depts md JOIN departments d ON d.id = md.dept_id
     ORDER BY d.code`);
  return months.map((m) => ({
    ...m,
    depts: depts.filter((d) => d.month_id === m.id).map(({ month_id: _m, ...d }) => d),
  }));
}

// ---------- upload context ----------

export type MonthContext = {
  period: string;
  packs: MonthPack[];
  leaves: { leafId: number; deliverySystem: string; routeCode: string }[];
  takenLeafIds: number[];
};

export async function monthContext(db: D1Database, monthId: number, deptId: number): Promise<MonthContext> {
  const m = await getMonth(db, monthId);
  await getMonthDept(db, monthId, deptId);
  const leaves = await all<{ leafId: number; deliverySystem: string; routeCode: string }>(
    db,
    `SELECT id AS leafId, delivery_system AS deliverySystem, route_code AS routeCode
     FROM leaves WHERE dept_id = ? ORDER BY id`, deptId);
  const taken = await all<{ leaf_id: number }>(db, `SELECT leaf_id FROM month_leaves WHERE month_id = ? ORDER BY leaf_id`, monthId);
  return { period: m.period, packs: packsOf(m), leaves, takenLeafIds: taken.map((t) => t.leaf_id) };
}

// ---------- files ----------

export async function addFile(db: D1Database, actorId: number, monthId: number, body: Obj): Promise<{ fileId: number }> {
  const deptId = positive(body.deptId, 'deptId');
  const name = text(body.name, 'name');
  const m = await getMonth(db, monthId);
  const state = await getMonthDept(db, monthId, deptId).catch((e) => {
    if (e instanceof ApiError && e.status === 404) throw bad('deptId is not part of this month');
    throw e;
  });
  if (state !== 'loading') throw conflict('department_not_loading');

  let sheet1: string | null = null;
  if (body.sheet1 !== undefined && body.sheet1 !== null) {
    const g = body.sheet1;
    if (typeof g !== 'object' || Array.isArray(g)) throw bad('sheet1 must be an object of pack code to cases');
    const known = new Set(packsOf(m).map((x) => x.code));
    for (const [k, v] of Object.entries(g as Obj)) {
      if (!known.has(k)) throw bad(`sheet1 has a pack that is not in this month: ${k}`);
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_VALUE) {
        throw bad(`sheet1 cases for ${k} must be a number of at least 0`);
      }
    }
    sheet1 = JSON.stringify(g);
  }

  const [ins] = await writeBatch(db, [
    db.prepare(
      `INSERT INTO month_files(month_id, dept_id, name, sheet1_json, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id AS fileId`,
    ).bind(monthId, deptId, name, sheet1, actorId, new Date().toISOString()),
    auditStatement(db, actorId, 'month.file_add', { monthId }, { deptId, name }, { lastInsertIdAs: 'fileId' }),
  ], 'conflict');
  return ins!.results[0] as { fileId: number };
}

// ---------- forecast batches ----------

type Checked = { leafId: number; salesmanId: string | null; values: Record<string, number>; line: number };

/** Shape checks only (no database). Collects every problem, up to MAX_REPORTED. */
function checkGrids(raw: unknown[], packs: MonthPack[]): Checked[] {
  const codes = packs.map((x) => x.code);
  const known = new Set(codes);
  const errors: { line: number; detail: string }[] = [];
  const out: Checked[] = [];
  const seen = new Set<number>();
  const fail = (line: number, detail: string) => { if (errors.length < MAX_REPORTED) errors.push({ line, detail }); };

  raw.forEach((g, i) => {
    const line = i + 1;
    if (!g || typeof g !== 'object' || Array.isArray(g)) return fail(line, 'grid must be an object');
    const o = g as Partial<LeafGrid> & Obj;
    if (typeof o.leafId !== 'number' || !Number.isInteger(o.leafId) || o.leafId < 1) return fail(line, 'leafId must be a positive integer');
    if (seen.has(o.leafId)) return fail(line, `leaf ${o.leafId} appears twice in this batch`);
    seen.add(o.leafId);
    let salesmanId: string | null = null;
    if (o.salesmanId !== undefined && o.salesmanId !== null) {
      if (typeof o.salesmanId !== 'string' || o.salesmanId.length > 100) return fail(line, 'salesmanId must be a text of at most 100 characters');
      salesmanId = o.salesmanId.trim() || null;
    }
    const v = o.values;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(line, 'values must be an object of pack code to cases');
    for (const k of Object.keys(v)) if (!known.has(k)) return fail(line, `pack ${k} is not in this month`);
    const values: Record<string, number> = {};
    for (const code of codes) {
      const n = (v as Record<string, unknown>)[code];
      if (n === undefined) return fail(line, `pack ${code} is missing (every pack is required)`);
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_VALUE) {
        return fail(line, `cases for ${code} must be a whole number of at least 0`);
      }
      values[code] = n;
    }
    out.push({ leafId: o.leafId, salesmanId, values, line });
  });
  if (errors.length) throw new ApiError(400, { error: 'invalid_request', detail: 'some grids are not valid', errors });
  return out;
}

export async function uploadBatch(
  db: D1Database, actorId: number, monthId: number, fileId: number, body: Obj,
): Promise<{ count: number }> {
  if (!Array.isArray(body.grids)) throw bad('grids must be an array');
  if (body.grids.length > MAX_INSERT_ROWS) throw new ApiError(413, { error: 'too_many_rows', detail: `at most ${MAX_INSERT_ROWS} grids per batch` });
  if (body.grids.length === 0) throw bad('grids must not be empty');

  const f = await one<{ dept_id: number; packs_json: string; state: string }>(
    db,
    `SELECT f.dept_id, m.packs_json, md.state
     FROM month_files f
     JOIN months m ON m.id = f.month_id
     JOIN month_depts md ON md.month_id = f.month_id AND md.dept_id = f.dept_id
     WHERE f.id = ? AND f.month_id = ?`, fileId, monthId);
  if (!f) throw notFound();
  if (f.state !== 'loading') throw conflict('department_not_loading');

  const grids = checkGrids(body.grids, packsOf(f));

  const leaves = await all<{
    id: number; dept_id: number; node_id: number; delivery_system: string; route_code: string;
    taken_file: number | null; in_month: number;
  }>(
    db,
    `SELECT l.id, l.dept_id, l.node_id, l.delivery_system, l.route_code,
            (SELECT ml.file_id FROM month_leaves ml WHERE ml.month_id = ? AND ml.leaf_id = l.id) AS taken_file,
            EXISTS (SELECT 1 FROM month_nodes mn WHERE mn.month_id = ? AND mn.node_id = l.node_id) AS in_month
     FROM leaves l WHERE l.id IN (SELECT value FROM json_each(?))`,
    monthId, monthId, JSON.stringify(grids.map((g) => g.leafId)));
  const byId = new Map(leaves.map((l) => [l.id, l]));

  const errors: { line: number; detail: string }[] = [];
  for (const g of grids) {
    const l = byId.get(g.leafId);
    if (!l) errors.push({ line: g.line, detail: `leaf ${g.leafId} does not exist` });
    else if (l.dept_id !== f.dept_id) errors.push({ line: g.line, detail: `leaf ${g.leafId} belongs to another department` });
  }
  if (errors.length) {
    throw new ApiError(400, { error: 'invalid_request', detail: 'some leaves cannot be loaded here', errors: errors.slice(0, MAX_REPORTED) });
  }
  const inOtherFile = leaves.filter((l) => l.taken_file !== null && l.taken_file !== fileId).map((l) => l.id);
  if (inOtherFile.length) throw conflict('leaf_in_other_file', inOtherFile.slice(0, MAX_REPORTED));
  const orphaned = leaves.filter((l) => !l.in_month).map((l) => l.id);
  if (orphaned.length) throw conflict('leaf_node_not_in_month', orphaned.slice(0, MAX_REPORTED));

  const rows = grids.map((g) => {
    const l = byId.get(g.leafId)!;
    return {
      month_id: monthId, leaf_id: l.id, node_id: l.node_id, dept_id: f.dept_id, file_id: fileId,
      delivery_system: l.delivery_system, route_code: l.route_code, salesman_id: g.salesmanId,
      values_json: JSON.stringify(g.values),
    };
  });
  const cols = ['month_id', 'leaf_id', 'node_id', 'dept_id', 'file_id', 'delivery_system', 'route_code', 'salesman_id', 'values_json'];
  await writeBatch(db, [
    // Re-sending a batch replaces its own leaves; the WHERE keeps a concurrent
    // upload from another file from being overwritten.
    insertJsonStatement(db, 'month_leaves', cols, rows, {
      onConflict: `ON CONFLICT(month_id, leaf_id) DO UPDATE SET
        node_id = excluded.node_id, dept_id = excluded.dept_id, delivery_system = excluded.delivery_system,
        route_code = excluded.route_code, salesman_id = excluded.salesman_id, values_json = excluded.values_json
        WHERE month_leaves.file_id = excluded.file_id`,
    }),
    auditStatement(db, actorId, 'month.batch', { monthId }, { fileId, count: rows.length }),
  ], 'conflict');
  return { count: rows.length };
}

// ---------- tree refresh ----------

const LOADING = `EXISTS (SELECT 1 FROM month_depts WHERE month_id = ? AND dept_id = ? AND state = 'loading')`;

/**
 * Re-copies the live tree of ONE department into a month, in four set-based
 * statements (never per row), each guarded so it only acts while the
 * department is 'loading':
 *  0. month_depts rows for any live department the month does not have yet;
 *  1. name / manager / parent of existing month nodes follow the live tree;
 *  2. live nodes the month lacks are inserted as waiting;
 *  3. month nodes that are gone live are removed, unless they hold month
 *     leaves (or are an ancestor of a node that does).
 * Statement 0 has no guard (it is what creates the row the guard looks for).
 * The month only ever holds the live root (parent NULL) unless a kept stale
 * node is a root; refreshTree refuses that case up front.
 */
export function treeSyncStatements(db: D1Database, monthId: number, deptId: number): D1PreparedStatement[] {
  return [
    db.prepare(
      `INSERT INTO month_depts(month_id, dept_id, state)
       SELECT ?, d.id, 'loading' FROM departments d
       WHERE NOT EXISTS (SELECT 1 FROM month_depts md WHERE md.month_id = ? AND md.dept_id = d.id)`,
    ).bind(monthId, monthId),
    db.prepare(
      `UPDATE month_nodes SET
         name = (SELECT n.name FROM nodes n WHERE n.id = month_nodes.node_id),
         manager_user_id = (SELECT n.manager_user_id FROM nodes n WHERE n.id = month_nodes.node_id),
         parent_id = (SELECT n.parent_id FROM nodes n WHERE n.id = month_nodes.node_id)
       WHERE month_id = ? AND dept_id = ? AND node_id IN (SELECT id FROM nodes WHERE dept_id = ?) AND ${LOADING}`,
    ).bind(monthId, deptId, deptId, monthId, deptId),
    db.prepare(
      `INSERT INTO month_nodes(month_id, node_id, dept_id, parent_id, name, manager_user_id, status, version)
       SELECT ?, n.id, n.dept_id, n.parent_id, n.name, n.manager_user_id, 'waiting', 0 FROM nodes n
       WHERE n.dept_id = ? AND ${LOADING}
         AND NOT EXISTS (SELECT 1 FROM month_nodes mn WHERE mn.month_id = ? AND mn.node_id = n.id)`,
    ).bind(monthId, deptId, monthId, deptId, monthId),
    db.prepare(
      `WITH RECURSIVE keep(id) AS (
         SELECT DISTINCT ml.node_id FROM month_leaves ml WHERE ml.month_id = ? AND ml.dept_id = ?
         UNION
         SELECT mn.parent_id FROM month_nodes mn JOIN keep ON mn.node_id = keep.id
         WHERE mn.month_id = ? AND mn.parent_id IS NOT NULL
       )
       DELETE FROM month_nodes
       WHERE month_id = ? AND dept_id = ? AND ${LOADING}
         AND node_id NOT IN (SELECT id FROM nodes WHERE dept_id = ?)
         AND node_id NOT IN (SELECT id FROM keep)`,
    ).bind(monthId, deptId, monthId, monthId, deptId, monthId, deptId, deptId),
  ];
}

/** Admin action: refresh the month's copy of a department's tree from the live tree (only while 'loading'). */
export async function refreshTree(
  db: D1Database, actorId: number, monthId: number, deptId: number,
): Promise<{ added: number; removed: number }> {
  await getMonth(db, monthId);
  const dept = await one<{ id: number }>(db, `SELECT id FROM departments WHERE id = ?`, deptId);
  if (!dept) throw notFound();
  const cur = await one<{ state: string }>(db, `SELECT state FROM month_depts WHERE month_id = ? AND dept_id = ?`, monthId, deptId);
  if (cur && cur.state !== 'loading') throw conflict('department_not_loading');

  // A removed live root that still holds month leaves would stay as a second root next to the new one.
  const staleRoot = await one<{ n: number }>(
    db,
    `WITH RECURSIVE keep(id) AS (
       SELECT DISTINCT ml.node_id FROM month_leaves ml WHERE ml.month_id = ? AND ml.dept_id = ?
       UNION
       SELECT mn.parent_id FROM month_nodes mn JOIN keep ON mn.node_id = keep.id
       WHERE mn.month_id = ? AND mn.parent_id IS NOT NULL
     )
     SELECT COUNT(*) AS n FROM month_nodes mn
     WHERE mn.month_id = ? AND mn.dept_id = ? AND mn.parent_id IS NULL
       AND mn.node_id NOT IN (SELECT id FROM nodes WHERE dept_id = ?) AND mn.node_id IN (SELECT id FROM keep)
       AND EXISTS (SELECT 1 FROM nodes WHERE dept_id = ? AND parent_id IS NULL)`,
    monthId, deptId, monthId, monthId, deptId, deptId, deptId);
  if (staleRoot && staleRoot.n > 0) throw conflict('stale_root_has_leaves');

  const res = await writeBatch(db, [
    ...treeSyncStatements(db, monthId, deptId),
    auditStatement(db, actorId, 'month.tree_refresh', { monthId }, { deptId }),
  ], 'conflict');
  return { added: res[2]!.meta.changes ?? 0, removed: res[3]!.meta.changes ?? 0 };
}

// ---------- reset / start ----------

export async function resetDept(db: D1Database, actorId: number, monthId: number, deptId: number): Promise<void> {
  // A department made after the month was opened (a new or re-uploaded Head): it joins the month now.
  await db.prepare(`INSERT OR IGNORE INTO month_depts(month_id, dept_id, state)
    SELECT m.id, d.id, 'loading' FROM months m, departments d WHERE m.id = ? AND d.id = ?`).bind(monthId, deptId).run();
  const cur = await one<{ state: string; files: number; leaves: number }>(
    db,
    `SELECT md.state,
            (SELECT COUNT(*) FROM month_files f WHERE f.month_id = md.month_id AND f.dept_id = md.dept_id) AS files,
            (SELECT COUNT(*) FROM month_leaves l WHERE l.month_id = md.month_id AND l.dept_id = md.dept_id) AS leaves
     FROM month_depts md WHERE md.month_id = ? AND md.dept_id = ?`, monthId, deptId);
  if (!cur) throw notFound();
  await writeBatch(db, [
    // month_leaves reference month_files, so they go first.
    db.prepare(`DELETE FROM month_leaves WHERE month_id = ? AND dept_id = ?`).bind(monthId, deptId),
    db.prepare(`DELETE FROM month_files WHERE month_id = ? AND dept_id = ?`).bind(monthId, deptId),
    db.prepare(
      `UPDATE month_nodes SET status = 'waiting', held_status = NULL, baseline_json = NULL, draft_json = NULL,
              opened_at = NULL, submitted_at = NULL, version = version + 1
       WHERE month_id = ? AND dept_id = ?`,
    ).bind(monthId, deptId),
    db.prepare(`UPDATE month_depts SET state = 'loading' WHERE month_id = ? AND dept_id = ?`).bind(monthId, deptId),
    // The reset department starts again from the live tree.
    ...treeSyncStatements(db, monthId, deptId),
    auditStatement(db, actorId, 'month.dept_reset', { monthId },
      { deptId, previousState: cur.state, files: cur.files, leaves: cur.leaves }),
  ], 'conflict');
}

export async function startDept(
  db: D1Database, env: Env, actorId: number, monthId: number, deptId: number,
): Promise<{ state: 'running' }> {
  const state = await getMonthDept(db, monthId, deptId);
  if (state === 'running') {
    // Ruling R16: start is re-runnable. If an earlier start set the department
    // running but opening the root's turn failed, open it now.
    const root = await one<{ node_id: number; status: string }>(
      db, `SELECT node_id, status FROM month_nodes WHERE month_id = ? AND dept_id = ? AND parent_id IS NULL`, monthId, deptId);
    if (root?.status === 'waiting') {
      await openTurn(db, env, monthId, root.node_id, actorId);
      return { state: 'running' };
    }
  }
  if (state !== 'loading') throw conflict('department_not_loading');

  const files = await one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM month_files WHERE month_id = ? AND dept_id = ?`, monthId, deptId);
  if (!files || files.n === 0) throw conflict('no_files');

  const root = await one<{ node_id: number }>(
    db, `SELECT node_id FROM month_nodes WHERE month_id = ? AND dept_id = ? AND parent_id IS NULL`, monthId, deptId);
  if (!root) throw conflict('no_root_node');

  // Live leaves of the department whose node is in this month's tree and that have no uploaded grid.
  const missing = await all<{ id: number }>(
    db,
    `SELECT l.id FROM leaves l
     WHERE l.dept_id = ?
       AND EXISTS (SELECT 1 FROM month_nodes mn WHERE mn.month_id = ? AND mn.node_id = l.node_id)
       AND NOT EXISTS (SELECT 1 FROM month_leaves ml WHERE ml.month_id = ? AND ml.leaf_id = l.id)
     ORDER BY l.id LIMIT ?`, deptId, monthId, monthId, MAX_REPORTED);
  if (missing.length) throw conflict('missing_leaves', missing.map((r) => r.id));

  await writeBatch(db, [
    db.prepare(`UPDATE month_depts SET state = 'running' WHERE month_id = ? AND dept_id = ?`).bind(monthId, deptId),
    auditStatement(db, actorId, 'month.dept_start', { monthId, nodeId: root.node_id }, { deptId }),
  ], 'conflict');
  await openTurn(db, env, monthId, root.node_id, actorId);
  return { state: 'running' };
}
