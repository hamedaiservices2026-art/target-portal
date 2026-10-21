// Distribution: the manager workspace, drafts, opening turns and the top-down
// submit (spec sections 6-8).
//
// D1 budget (docs/decisions.md): a request reads the department's month_nodes
// and the leaves it needs with ONE db.batch() of SELECTs, works in memory, and
// writes with ONE atomic db.batch(): the leaf grids go out as set-based
// `UPDATE ... FROM json_each(?)` statements (at most LEAF_UPDATE_CHUNK leaves
// each), the child turns as one statement, the audit rows as two. Nothing is
// one statement per leaf or per child.
//
// Concurrency: every write in a submit/draft/open batch is guarded by the
// node's version and status as read, so a racing request makes the whole batch
// a no-op; the node's own UPDATE reports whether it applied (else 409 stale).
//
// CPU (~10 ms per request on the free plan): the in-memory work lives in
// plan.ts on pack-indexed vectors. SQLite turns each leaf's values_json into a
// compact number array on read and rebuilds the object on write, so the Worker
// never parses or builds the 42-key objects. Leaves are loaded for the node's
// subtree only (a supervisor never touches the whole department).
import { checkAll } from '../../shared/rules';
import { ancestors } from '../../shared/tree';
import type { ChildKey, Grid, NodeStatus } from '../../shared/types';
import type { SessionUser } from '../auth';
import { all, batch, type Bindable } from '../db';
import type { Env } from '../index';
import { ApiError, bad, capPctFrom, forbidden, int, notFound, type Obj } from './masters';
import {
  buildTree, childGrids, childKeys, compactLeaves, gridOf, leafPayload, NoRoutesError, planSubmit, preorder, subtreeTotals, vecOf,
  type MonthPack, type NodeRow, type RawLeaf, type Tree,
} from './plan';

/** Leaves per UPDATE statement (one bound JSON parameter, well under D1's value size limit). */
export const LEAF_UPDATE_CHUNK = 500;
const MAX_VALUE = 1_000_000_000;

export type { MonthPack } from './plan';

export interface Workspace {
  month: { id: number; period: string; deadline: string | null };
  node: { id: number; name: string; status: NodeStatus; deptCode: string };
  capPct: number;
  packs: MonthPack[];
  totals: Grid;
  children: { key: ChildKey; label: string; sub: string; starts: Grid; values: Grid }[];
  version: number;
  editable: boolean;
}

export type BranchNode = { nodeId: number; parentId: number | null; name: string; manager: string; status: NodeStatus; totals: Grid };

export type TaskDto = {
  monthId: number; period: string; nodeId: number; nodeName: string; deptCode: string; status: NodeStatus; deadline: string | null;
};

export type SubmitResult = { version: number; status: 'submitted'; deptComplete: boolean };

const conflict = (detail: string) => new ApiError(409, { error: 'conflict', detail });
const stale = () => new ApiError(409, { error: 'stale' });

// ---------- notification hooks (Task 14 wires email here) ----------

/** Called after the turns of `nodeIds` opened. No-op until Task 14 (queueMail). */
export function notifyTurnOpened(_env: Env, _monthId: number, _nodeIds: number[]): void {}

/** Called after a department became complete. No-op until Task 14 (admin email). */
export function notifyDeptComplete(_env: Env, _monthId: number, _deptId: number): void {}

// ---------- loading ----------

interface Dept extends Tree {
  month: { id: number; period: string; deadline: string | null };
  deptId: number;
  deptCode: string;
  capPct: number;
  packs: MonthPack[];
}

type LeafScope = 'none' | 'direct' | 'subtree';

/**
 * A pack code can be put in a quoted JSON path (`$."code"`) unless it holds a
 * double quote or a backslash (SQLite paths have no escapes). Leaves of a
 * month with such a code are read as stored objects instead (slower, rare).
 */
const pathSafe = (code: string): boolean => !code.includes('"') && !code.includes('\\');

/** Leaves per aggregated row of the compact read (keeps each row far below D1's 2 MB value limit). */
const LEAF_READ_CHUNK = 500;

function leafQuery(db: D1Database, monthId: number, nodeId: number, scope: 'direct' | 'subtree', compact: boolean): D1PreparedStatement {
  const where = scope === 'direct' ? `l.month_id = ? AND l.node_id = ?` : `l.month_id = ? AND l.node_id IN (SELECT id FROM sub)`;
  const sub = scope === 'direct' ? '' :
    `sub(id) AS (SELECT ? UNION SELECT mn.node_id FROM month_nodes mn JOIN sub ON mn.parent_id = sub.id WHERE mn.month_id = ?),`;
  const subArgs = scope === 'direct' ? [] : [nodeId, monthId];
  const whereArgs = scope === 'direct' ? [monthId, nodeId] : [monthId];
  if (!compact) {
    return db.prepare(
      `WITH RECURSIVE ${sub} x AS (SELECT 1)
       SELECT l.leaf_id, l.node_id, l.route_code, l.salesman_id, l.values_json FROM month_leaves l
       WHERE ${where} ORDER BY l.route_code, l.leaf_id`,
    ).bind(...subArgs, ...whereArgs);
  }
  // Compact: rows of `[[leaf_id, node_id, route_code, salesman_id, [v0, v1, ...]], ...]`,
  // up to LEAF_READ_CHUNK leaves each, values in snapshot pack order (missing
  // pack -> 0), built by SQLite from months.packs_json, so the Worker parses a
  // few compact strings instead of 2,000 objects. The path of an unsafe code is
  // NULL so the query cannot fail (the caller then re-reads values_json).
  return db.prepare(
    `WITH RECURSIVE ${sub}
     p(i, path) AS MATERIALIZED (
       SELECT key, CASE WHEN instr(json_extract(value, '$.code'), '"') > 0 OR instr(json_extract(value, '$.code'), char(92)) > 0
                        THEN NULL ELSE '$."' || json_extract(value, '$.code') || '"' END
       FROM json_each((SELECT packs_json FROM months WHERE id = ?))),
     r AS (
       SELECT l.leaf_id, l.node_id, l.route_code, l.salesman_id,
              (SELECT json_group_array(COALESCE(json_extract(l.values_json, p.path), 0) ORDER BY p.i) FROM p) AS v,
              (ROW_NUMBER() OVER (ORDER BY l.route_code, l.leaf_id) - 1) / ${LEAF_READ_CHUNK} AS chunk
       FROM month_leaves l WHERE ${where})
     SELECT json_group_array(json_array(leaf_id, node_id, route_code, salesman_id, json(v)) ORDER BY route_code, leaf_id) AS rows
     FROM r GROUP BY chunk ORDER BY chunk`,
  ).bind(...subArgs, monthId, ...whereArgs);
}

/**
 * One batch of SELECTs: the month/department header, every month_node of the
 * department, and the leaves in `scope` of `nodeId` (none, its direct leaves,
 * or its whole subtree via a recursive CTE on idx_month_nodes_parent).
 */
async function loadDept(db: D1Database, monthId: number, nodeId: number, scope: LeafScope): Promise<{ d: Dept; node: NodeRow }> {
  const deptOf = `(SELECT dept_id FROM month_nodes WHERE month_id = ? AND node_id = ?)`;
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `SELECT m.id, m.period, m.deadline, m.packs_json, n.dept_id, d.code AS dept_code,
              (SELECT value FROM settings WHERE key = 'cap_pct') AS cap_pct
       FROM month_nodes n JOIN months m ON m.id = n.month_id JOIN departments d ON d.id = n.dept_id
       WHERE n.month_id = ? AND n.node_id = ?`,
    ).bind(monthId, nodeId),
    db.prepare(
      `SELECT mn.node_id, mn.parent_id, mn.name, mn.manager_user_id, u.name AS manager_name, mn.status, mn.held_status,
              mn.baseline_json, mn.draft_json, mn.version
       FROM month_nodes mn LEFT JOIN users u ON u.id = mn.manager_user_id
       WHERE mn.month_id = ? AND mn.dept_id = ${deptOf}
       ORDER BY mn.name, mn.node_id`,
    ).bind(monthId, monthId, nodeId),
  ];
  if (scope !== 'none') stmts.push(leafQuery(db, monthId, nodeId, scope, true));
  const [head, nodesRes, leavesRes] = await batch(db, stmts);
  const h = head!.results[0] as
    | { id: number; period: string; deadline: string | null; packs_json: string; dept_id: number; dept_code: string; cap_pct: string | null }
    | undefined;
  if (!h) throw notFound();

  const packs = JSON.parse(h.packs_json) as MonthPack[];
  const codes = packs.map((p) => p.code);
  let leafRows: RawLeaf[] = [];
  if (scope !== 'none') {
    leafRows = codes.every(pathSafe)
      ? compactLeaves((leavesRes!.results as { rows: string }[]).map((r) => r.rows))
      : (await leafQuery(db, monthId, nodeId, scope, false).all<RawLeaf>()).results;
  }
  const tree = buildTree(codes, nodesRes!.results as NodeRow[], leafRows);
  const d: Dept = {
    ...tree,
    month: { id: h.id, period: h.period, deadline: h.deadline },
    deptId: h.dept_id,
    deptCode: h.dept_code,
    capPct: capPctFrom(h.cap_pct),
    packs,
  };
  return { d, node: d.nodes.get(nodeId)! };
}

/** The grid for a child key of a stored baseline/draft, restricted to the snapshot packs (missing -> 0). */
const pick = (g: Grid | undefined, codes: string[]): Grid => Object.fromEntries(codes.map((c) => [c, g?.[c] ?? 0]));

const sameGrid = (a: Grid, b: Grid, codes: string[]): boolean => codes.every((c) => (a[c] ?? 0) === (b[c] ?? 0));

const parseGrids = (json: string | null): Record<ChildKey, Grid> | null =>
  json === null ? null : (JSON.parse(json) as Record<ChildKey, Grid>);

function canView(d: Dept, user: SessionUser, nodeId: number): boolean {
  if (user.role === 'admin') return true;
  if (d.nodes.get(nodeId)?.manager_user_id === user.id) return true;
  const list = [...d.nodes.values()].map((n) => ({ id: n.node_id, parent_id: n.parent_id }));
  return ancestors(list, nodeId).some((a) => d.nodes.get(a)?.manager_user_id === user.id);
}

// ---------- guarded write statements ----------

/** `EXISTS(...)` true while the node still has the version and status that were read. */
type Guard = { sql: string; args: Bindable[] };
function guard(monthId: number, nodeId: number, version: number, status: string): Guard {
  return {
    sql: `EXISTS (SELECT 1 FROM month_nodes g WHERE g.month_id = ? AND g.node_id = ? AND g.version = ? AND g.status = ?)`,
    args: [monthId, nodeId, version, status],
  };
}

function auditIf(
  db: D1Database, g: Guard, userId: number | null, action: string, monthId: number, nodeId: number, detail: unknown, at: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit(at, user_id, action, month_id, node_id, detail_json) SELECT ?, ?, ?, ?, ?, ? WHERE ${g.sql}`,
  ).bind(at, userId, action, monthId, nodeId, detail === undefined ? null : JSON.stringify(detail), ...g.args);
}

/** One 'node.open' audit row per node id, one statement. */
function auditOpensIf(db: D1Database, g: Guard, userId: number | null, monthId: number, nodeIds: number[], detail: unknown, at: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit(at, user_id, action, month_id, node_id, detail_json)
     SELECT ?, ?, 'node.open', ?, value, ? FROM json_each(?) WHERE ${g.sql}`,
  ).bind(at, userId, monthId, JSON.stringify(detail), JSON.stringify(nodeIds), ...g.args);
}

// The json_each rows are MATERIALIZED so SQLite scans them once and looks each
// target row up by primary key. Without it the planner scans the table and
// re-reads json_each per row (quadratic: ~3 s for 500 leaves).

/** Opens the turns of several nodes in one statement: each gets its own baseline. */
function openTurnsIf(db: D1Database, g: Guard, monthId: number, items: { id: number; b: Record<ChildKey, Grid> }[], at: string): D1PreparedStatement {
  return db.prepare(
    `WITH j(id, b) AS MATERIALIZED (SELECT json_extract(value, '$.id'), json_extract(value, '$.b') FROM json_each(?))
     UPDATE month_nodes
        SET status = 'in_progress', held_status = NULL, baseline_json = j.b, draft_json = NULL,
            opened_at = ?, version = month_nodes.version + 1
       FROM j
      WHERE month_nodes.month_id = ? AND month_nodes.node_id = j.id AND ${g.sql}`,
  ).bind(JSON.stringify(items), at, monthId, ...g.args);
}

/**
 * Rewrites the grids of up to LEAF_UPDATE_CHUNK leaves in one statement. The
 * payload is compact rows (`[[leafId, v0, v1, ...], ...]`, see plan.ts);
 * SQLite builds each values_json object from a row and the snapshot pack codes.
 */
function updateLeavesIf(db: D1Database, g: Guard, monthId: number, codes: string[], payload: string): D1PreparedStatement {
  return db.prepare(
    `WITH c(i, code) AS MATERIALIZED (SELECT key, value FROM json_each(?)),
          j(id, v) AS MATERIALIZED (SELECT json_extract(value, '$[0]'), value FROM json_each(?))
     UPDATE month_leaves
        SET values_json = (SELECT json_group_object(c.code, json_extract(j.v, '$[' || (c.i + 1) || ']') ORDER BY c.i) FROM c)
       FROM j
      WHERE month_leaves.month_id = ? AND month_leaves.leaf_id = j.id AND ${g.sql}`,
  ).bind(JSON.stringify(codes), payload, monthId, ...g.args);
}

// ---------- reads ----------

export async function childTotals(db: D1Database, monthId: number, nodeId: number): Promise<Record<ChildKey, Grid>> {
  const { d } = await loadDept(db, monthId, nodeId, 'subtree');
  return childGrids(d, nodeId, subtreeTotals(d, nodeId));
}

export async function getWorkspace(db: D1Database, user: SessionUser, monthId: number, nodeId: number): Promise<Workspace> {
  const { d, node } = await loadDept(db, monthId, nodeId, 'subtree');
  if (!canView(d, user, nodeId)) throw forbidden();
  const totals = subtreeTotals(d, nodeId);
  const starts = parseGrids(node.baseline_json) ?? childGrids(d, nodeId, totals);
  const values = parseGrids(node.draft_json) ?? starts;
  const ownLeaves = new Map((d.leavesByNode.get(nodeId) ?? []).map((l) => [l.leaf_id, l]));
  const children = childKeys(d, nodeId).map((key) => {
    const id = Number(key.slice(2));
    let label: string;
    let sub: string;
    if (key.startsWith('n:')) {
      const n = d.nodes.get(id)!;
      label = n.name;
      sub = n.manager_name ?? '';
    } else {
      const l = ownLeaves.get(id)!;
      label = l.route_code;
      sub = l.salesman_id ?? '';
    }
    return { key, label, sub, starts: pick(starts[key], d.codes), values: pick(values[key], d.codes) };
  });
  return {
    month: d.month,
    node: { id: nodeId, name: node.name, status: node.status, deptCode: d.deptCode },
    capPct: d.capPct,
    packs: d.packs,
    totals: gridOf(totals.get(nodeId)!, d.codes),
    children,
    version: node.version,
    editable: node.manager_user_id === user.id && node.status === 'in_progress',
  };
}

export async function getBranch(db: D1Database, user: SessionUser, monthId: number, nodeId: number): Promise<BranchNode[]> {
  const { d } = await loadDept(db, monthId, nodeId, 'subtree');
  if (!canView(d, user, nodeId)) throw forbidden();
  const totals = subtreeTotals(d, nodeId);
  return preorder(d, nodeId).map((id) => {
    const n = d.nodes.get(id)!;
    return { nodeId: id, parentId: n.parent_id, name: n.name, manager: n.manager_name ?? '', status: n.status, totals: gridOf(totals.get(id)!, d.codes) };
  });
}

/** Month nodes the user manages, all months, newest month first (idx_month_nodes_manager). */
export async function myTasks(db: D1Database, userId: number): Promise<TaskDto[]> {
  return all<TaskDto>(
    db,
    `SELECT mn.month_id AS monthId, m.period, mn.node_id AS nodeId, mn.name AS nodeName, d.code AS deptCode,
            mn.status, m.deadline
     FROM month_nodes mn JOIN months m ON m.id = mn.month_id JOIN departments d ON d.id = mn.dept_id
     WHERE mn.manager_user_id = ?
     ORDER BY m.period DESC, d.code, mn.name, mn.node_id`, userId);
}

// ---------- open a turn ----------

/**
 * Opens `nodeId`'s turn: baseline = its child totals now, draft cleared,
 * status in_progress, opened_at, version+1, audit 'node.open', then the
 * "turn opened" notification. Idempotent: an in-progress node with no draft
 * is left as it is (Ruling R16: dept start can be re-run safely).
 */
export async function openTurn(db: D1Database, env: Env, monthId: number, nodeId: number, actorId: number | null = null): Promise<void> {
  const { d, node } = await loadDept(db, monthId, nodeId, 'subtree');
  if (node.status === 'in_progress' && node.draft_json === null) return;
  const baseline = childGrids(d, nodeId, subtreeTotals(d, nodeId));
  const now = new Date().toISOString();
  const g = guard(monthId, nodeId, node.version, node.status);
  const res = await batch(db, [
    // The audit row goes first: the guard still sees the version that was read.
    auditIf(db, g, actorId, 'node.open', monthId, nodeId, { version: node.version + 1 }, now),
    openTurnsIf(db, g, monthId, [{ id: nodeId, b: baseline }], now),
  ]);
  if ((res[1]!.meta.changes ?? 0) !== 1) throw stale();
  notifyTurnOpened(env, monthId, [nodeId]);
}

// ---------- drafts ----------

function version(v: unknown): number {
  const n = int(v, 'version');
  if (n < 0) throw bad('version must be an integer of at least 0');
  return n;
}

/** Exactly the node's children, each with exactly the snapshot packs, whole cases >= 0. */
function parseValues(raw: unknown, keys: ChildKey[], codes: string[]): Record<ChildKey, Grid> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('values must be an object of child key to grid');
  const obj = raw as Obj;
  const want = new Set<string>(keys);
  const got = Object.keys(obj);
  for (const k of got) if (!want.has(k)) throw bad(`values has a key that is not a team member of this node: ${k}`);
  if (got.length !== keys.length) throw bad('values must have a grid for every team member of this node');
  const packSet = new Set(codes);
  const out: Record<ChildKey, Grid> = {};
  for (const k of keys) {
    const g = obj[k];
    if (!g || typeof g !== 'object' || Array.isArray(g)) throw bad(`values for ${k} must be an object of pack code to cases`);
    const grid = g as Obj;
    for (const c of Object.keys(grid)) if (!packSet.has(c)) throw bad(`values for ${k} have a pack that is not in this month: ${c}`);
    const clean: Grid = {};
    for (const c of codes) {
      const n = grid[c];
      if (n === undefined) throw bad(`values for ${k} are missing pack ${c}`);
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_VALUE) {
        throw bad(`values for ${k}, pack ${c} must be a whole number of at least 0`);
      }
      clean[c] = n;
    }
    out[k] = clean;
  }
  return out;
}

/** Saves the manager's draft. Not rule-checked (the screen shows the rules); version-checked. */
export async function saveDraft(db: D1Database, actorId: number, monthId: number, nodeId: number, body: Obj): Promise<{ version: number }> {
  const expected = version(body.version);
  const { d, node } = await loadDept(db, monthId, nodeId, 'direct');
  if (node.manager_user_id !== actorId) throw forbidden();
  if (node.status !== 'in_progress') throw conflict('not_in_progress');
  const values = parseValues(body.values, childKeys(d, nodeId), d.codes);
  if (node.version !== expected) throw stale();

  const now = new Date().toISOString();
  const g = guard(monthId, nodeId, expected, 'in_progress');
  const res = await batch(db, [
    auditIf(db, g, actorId, 'node.draft', monthId, nodeId, { version: expected + 1 }, now),
    db.prepare(
      `UPDATE month_nodes SET draft_json = ?, version = version + 1
       WHERE month_id = ? AND node_id = ? AND version = ? AND status = 'in_progress'`,
    ).bind(JSON.stringify(values), monthId, nodeId, expected),
  ]);
  if ((res[1]!.meta.changes ?? 0) !== 1) throw stale();
  return { version: expected + 1 };
}

// ---------- submit ----------

/**
 * Submits `nodeId`'s distribution and opens its child nodes' turns.
 * `source`: 'draft' submits draft ?? baseline; 'baseline' submits the starting
 * numbers unchanged (admin push forward, Task 12).
 * `asManager`: the actor must be the node's manager (the manager route sets it;
 * the admin push does not). `expectedVersion`: optimistic lock (409 stale).
 *
 * Checks, in order: manager -> in_progress -> parent submitted -> version ->
 * cap rules on every snapshot pack (400 rules_failed with byPack). Then the new
 * leaf grids are computed in memory; before anything is written the
 * per-pack total over every leaf of the subtree (the only leaves written, so
 * the department total) must be unchanged, else it throws (500).
 */
export async function submitNode(
  db: D1Database, env: Env, monthId: number, nodeId: number, actorId: number, source: 'draft' | 'baseline',
  opts: { expectedVersion?: number; asManager?: boolean } = {},
): Promise<SubmitResult> {
  const { d, node } = await loadDept(db, monthId, nodeId, 'subtree');
  if (opts.asManager && node.manager_user_id !== actorId) throw forbidden();
  if (node.status !== 'in_progress') throw conflict('not_in_progress');
  if (node.parent_id !== null && d.nodes.get(node.parent_id)?.status !== 'submitted') throw conflict('parent_not_submitted');
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== node.version) throw stale();

  const { codes } = d;
  const totals = subtreeTotals(d, nodeId);
  const keys = childKeys(d, nodeId);
  const starts = parseGrids(node.baseline_json) ?? childGrids(d, nodeId, totals);
  const values = source === 'draft' ? (parseGrids(node.draft_json) ?? starts) : starts;
  const startList = keys.map((k) => pick(starts[k], codes));
  const valueList = keys.map((k) => pick(values[k], codes));
  const check = checkAll(gridOf(totals.get(nodeId)!, codes), startList, valueList, codes, d.capPct);
  if (!check.ok) throw new ApiError(400, { error: 'rules_failed', detail: 'some packs do not pass the rules', byPack: check.byPack });

  // New leaf vectors and the invariants (child totals = submitted values,
  // per-pack total of the subtree unchanged, whole cases >= 0), all in memory
  // before anything is written. The subtree's leaves are every leaf loaded and
  // the only leaves written, so its total unchanged means the department's is.
  let plan: ReturnType<typeof planSubmit>;
  try {
    plan = planSubmit(d, nodeId, keys, valueList.map((g) => vecOf(g, codes)), totals);
  } catch (e) {
    if (e instanceof NoRoutesError) throw bad(e.message);
    throw e;
  }
  const { next, newTotals } = plan;

  // ---- write: ONE atomic batch, every statement guarded by the version read ----
  const now = new Date().toISOString();
  const g = guard(monthId, nodeId, node.version, 'in_progress');
  const stmts: D1PreparedStatement[] = [];
  const changedLeaves = [...next.values()];
  for (let i = 0; i < changedLeaves.length; i += LEAF_UPDATE_CHUNK) {
    stmts.push(updateLeavesIf(db, g, monthId, codes, leafPayload(changedLeaves.slice(i, i + LEAF_UPDATE_CHUNK))));
  }
  // Task 12: a child with a held_status (reopen path) goes through
  // restoreOrReopen instead; until then every child node gets a fresh turn.
  const childIds = d.childNodes.get(nodeId) ?? [];
  if (childIds.length) {
    const items = childIds.map((id) => ({ id, b: childGrids(d, id, newTotals, next) }));
    stmts.push(auditOpensIf(db, g, actorId, monthId, childIds, { parentId: nodeId }, now));
    stmts.push(openTurnsIf(db, g, monthId, items, now));
  }
  const changedChildren = keys.filter((_k, i) => !sameGrid(startList[i]!, valueList[i]!, codes));
  stmts.push(auditIf(db, g, actorId, 'node.submit', monthId, nodeId, { changedChildren }, now));
  const submittedValues = Object.fromEntries(keys.map((k, i) => [k, valueList[i]!]));
  const nodeIdx = stmts.push(db.prepare(
    `UPDATE month_nodes SET status = 'submitted', submitted_at = ?, draft_json = ?, version = version + 1
     WHERE month_id = ? AND node_id = ? AND version = ? AND status = 'in_progress'`,
  ).bind(now, JSON.stringify(submittedValues), monthId, nodeId, node.version)) - 1;
  // Evaluated inside the same transaction, after this node is submitted, so
  // concurrent sibling submits cannot both miss completing the department.
  const deptIdx = stmts.push(db.prepare(
    `UPDATE month_depts SET state = 'complete'
     WHERE month_id = ? AND dept_id = ? AND state = 'running'
       AND NOT EXISTS (SELECT 1 FROM month_nodes WHERE month_id = ? AND dept_id = ? AND status IN ('waiting', 'in_progress'))`,
  ).bind(monthId, d.deptId, monthId, d.deptId)) - 1;

  const res = await batch(db, stmts);
  if ((res[nodeIdx]!.meta.changes ?? 0) !== 1) throw stale();
  const deptComplete = (res[deptIdx]!.meta.changes ?? 0) === 1;
  if (childIds.length) notifyTurnOpened(env, monthId, childIds);
  if (deptComplete) notifyDeptComplete(env, monthId, d.deptId);
  return { version: node.version + 1, status: 'submitted', deptComplete };
}
