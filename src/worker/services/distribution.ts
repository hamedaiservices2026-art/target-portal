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
// CPU: maps are built once; subtree totals are one post-order pass; leaves are
// loaded for the node's subtree only (a supervisor never parses the whole
// department).
import { checkAll } from '../../shared/rules';
import { rescale } from '../../shared/scaling';
import { ancestors } from '../../shared/tree';
import type { ChildKey, Grid, NodeStatus } from '../../shared/types';
import type { SessionUser } from '../auth';
import { all, batch, type Bindable } from '../db';
import type { Env } from '../index';
import { ApiError, bad, capPctFrom, forbidden, int, notFound, type Obj } from './masters';

/** Leaves per UPDATE statement (one bound JSON parameter, well under D1's value size limit). */
export const LEAF_UPDATE_CHUNK = 500;
const MAX_VALUE = 1_000_000_000;

export type MonthPack = { code: string; grp: string; sort: number };

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

type NodeRow = {
  node_id: number; parent_id: number | null; name: string; manager_user_id: number | null; manager_name: string | null;
  status: NodeStatus; held_status: string | null; baseline_json: string | null; draft_json: string | null; version: number;
};
type LeafRow = { leaf_id: number; node_id: number; route_code: string; salesman_id: string | null; values: Grid };

interface Dept {
  month: { id: number; period: string; deadline: string | null };
  deptId: number;
  deptCode: string;
  capPct: number;
  packs: MonthPack[];
  codes: string[];
  /** Every month_node of the department. */
  nodes: Map<number, NodeRow>;
  /** parent -> child node ids, ordered by name. */
  childNodes: Map<number, number[]>;
  /** node -> its direct leaves (only the leaves that were loaded), ordered by route code. */
  leavesByNode: Map<number, LeafRow[]>;
  leaves: LeafRow[];
}

type LeafScope = 'none' | 'direct' | 'subtree';

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
  const leafCols = `leaf_id, node_id, route_code, salesman_id, values_json`;
  if (scope === 'direct') {
    stmts.push(db.prepare(
      `SELECT ${leafCols} FROM month_leaves WHERE month_id = ? AND node_id = ? ORDER BY route_code, leaf_id`,
    ).bind(monthId, nodeId));
  } else if (scope === 'subtree') {
    stmts.push(db.prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT ? UNION SELECT mn.node_id FROM month_nodes mn JOIN sub ON mn.parent_id = sub.id WHERE mn.month_id = ?
       )
       SELECT ${leafCols} FROM month_leaves
       WHERE month_id = ? AND node_id IN (SELECT id FROM sub)
       ORDER BY route_code, leaf_id`,
    ).bind(nodeId, monthId, monthId));
  }
  const [head, nodesRes, leavesRes] = await batch(db, stmts);
  const h = head!.results[0] as
    | { id: number; period: string; deadline: string | null; packs_json: string; dept_id: number; dept_code: string; cap_pct: string | null }
    | undefined;
  if (!h) throw notFound();

  const packs = JSON.parse(h.packs_json) as MonthPack[];
  const nodes = new Map<number, NodeRow>();
  const childNodes = new Map<number, number[]>();
  for (const n of nodesRes!.results as NodeRow[]) {
    nodes.set(n.node_id, n);
    if (n.parent_id !== null) {
      const list = childNodes.get(n.parent_id);
      if (list) list.push(n.node_id);
      else childNodes.set(n.parent_id, [n.node_id]);
    }
  }
  const leaves: LeafRow[] = [];
  const leavesByNode = new Map<number, LeafRow[]>();
  for (const r of (leavesRes?.results ?? []) as (Omit<LeafRow, 'values'> & { values_json: string })[]) {
    const leaf: LeafRow = { leaf_id: r.leaf_id, node_id: r.node_id, route_code: r.route_code, salesman_id: r.salesman_id, values: JSON.parse(r.values_json) as Grid };
    leaves.push(leaf);
    const list = leavesByNode.get(r.node_id);
    if (list) list.push(leaf);
    else leavesByNode.set(r.node_id, [leaf]);
  }
  const d: Dept = {
    month: { id: h.id, period: h.period, deadline: h.deadline },
    deptId: h.dept_id,
    deptCode: h.dept_code,
    capPct: capPctFrom(h.cap_pct),
    packs,
    codes: packs.map((p) => p.code),
    nodes,
    childNodes,
    leavesByNode,
    leaves,
  };
  return { d, node: nodes.get(nodeId)! };
}

// ---------- in-memory grid helpers ----------

const zero = (codes: string[]): Grid => Object.fromEntries(codes.map((c) => [c, 0]));

/** A copy restricted to the snapshot packs (missing packs read as 0). */
const pick = (g: Grid | undefined, codes: string[]): Grid => Object.fromEntries(codes.map((c) => [c, g?.[c] ?? 0]));

function addInto(target: Grid, src: Grid, codes: string[]): void {
  for (const c of codes) target[c] = target[c]! + (src[c] ?? 0);
}

const sameGrid = (a: Grid, b: Grid, codes: string[]): boolean => codes.every((c) => (a[c] ?? 0) === (b[c] ?? 0));

type LeafValue = (leaf: LeafRow) => Grid;
const stored: LeafValue = (l) => l.values;

/** Node ids of `rootId`'s subtree in pre-order (children by name), including `rootId`. */
function preorder(d: Dept, rootId: number): number[] {
  const out: number[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    const kids = d.childNodes.get(id);
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out;
}

/** Σ of the loaded leaves per node, for every node of `rootId`'s subtree. One post-order pass. */
function subtreeTotals(d: Dept, rootId: number, valueOf: LeafValue): Map<number, Grid> {
  const order = preorder(d, rootId);
  const totals = new Map<number, Grid>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    const t = zero(d.codes);
    for (const l of d.leavesByNode.get(id) ?? []) addInto(t, valueOf(l), d.codes);
    for (const k of d.childNodes.get(id) ?? []) addInto(t, totals.get(k)!, d.codes);
    totals.set(id, t);
  }
  return totals;
}

/** Child nodes (by name) then direct leaves (by route code). */
function childKeys(d: Dept, nodeId: number): ChildKey[] {
  return [
    ...(d.childNodes.get(nodeId) ?? []).map((id) => `n:${id}` as ChildKey),
    ...(d.leavesByNode.get(nodeId) ?? []).map((l) => `l:${l.leaf_id}` as ChildKey),
  ];
}

function childTotalsOf(d: Dept, nodeId: number, totals: Map<number, Grid>, valueOf: LeafValue): Record<ChildKey, Grid> {
  const out: Record<ChildKey, Grid> = {};
  for (const id of d.childNodes.get(nodeId) ?? []) out[`n:${id}`] = { ...totals.get(id)! };
  for (const l of d.leavesByNode.get(nodeId) ?? []) out[`l:${l.leaf_id}`] = pick(valueOf(l), d.codes);
  return out;
}

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

/** Rewrites the packed grids of up to LEAF_UPDATE_CHUNK leaves in one statement. */
function updateLeavesIf(db: D1Database, g: Guard, monthId: number, items: { id: number; v: Grid }[]): D1PreparedStatement {
  return db.prepare(
    `WITH j(id, v) AS MATERIALIZED (SELECT json_extract(value, '$.id'), json_extract(value, '$.v') FROM json_each(?))
     UPDATE month_leaves SET values_json = j.v
       FROM j
      WHERE month_leaves.month_id = ? AND month_leaves.leaf_id = j.id AND ${g.sql}`,
  ).bind(JSON.stringify(items), monthId, ...g.args);
}

// ---------- reads ----------

export async function childTotals(db: D1Database, monthId: number, nodeId: number): Promise<Record<ChildKey, Grid>> {
  const { d } = await loadDept(db, monthId, nodeId, 'subtree');
  return childTotalsOf(d, nodeId, subtreeTotals(d, nodeId, stored), stored);
}

export async function getWorkspace(db: D1Database, user: SessionUser, monthId: number, nodeId: number): Promise<Workspace> {
  const { d, node } = await loadDept(db, monthId, nodeId, 'subtree');
  if (!canView(d, user, nodeId)) throw forbidden();
  const totals = subtreeTotals(d, nodeId, stored);
  const starts = parseGrids(node.baseline_json) ?? childTotalsOf(d, nodeId, totals, stored);
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
    totals: totals.get(nodeId)!,
    children,
    version: node.version,
    editable: node.manager_user_id === user.id && node.status === 'in_progress',
  };
}

export async function getBranch(db: D1Database, user: SessionUser, monthId: number, nodeId: number): Promise<BranchNode[]> {
  const { d } = await loadDept(db, monthId, nodeId, 'subtree');
  if (!canView(d, user, nodeId)) throw forbidden();
  const totals = subtreeTotals(d, nodeId, stored);
  return preorder(d, nodeId).map((id) => {
    const n = d.nodes.get(id)!;
    return { nodeId: id, parentId: n.parent_id, name: n.name, manager: n.manager_name ?? '', status: n.status, totals: totals.get(id)! };
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
  const baseline = childTotalsOf(d, nodeId, subtreeTotals(d, nodeId, stored), stored);
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
  const totals = subtreeTotals(d, nodeId, stored);
  const keys = childKeys(d, nodeId);
  const starts = parseGrids(node.baseline_json) ?? childTotalsOf(d, nodeId, totals, stored);
  const values = source === 'draft' ? (parseGrids(node.draft_json) ?? starts) : starts;
  const startList = keys.map((k) => pick(starts[k], codes));
  const valueList = keys.map((k) => pick(values[k], codes));
  const check = checkAll(totals.get(nodeId)!, startList, valueList, codes, d.capPct);
  if (!check.ok) throw new ApiError(400, { error: 'rules_failed', detail: 'some packs do not pass the rules', byPack: check.byPack });

  // ---- apply in memory ----
  const leafById = new Map(d.leaves.map((l) => [l.leaf_id, l]));
  const next = new Map<number, Grid>(); // leaf id -> new grid (copy-on-write)
  const gridFor = (l: LeafRow): Grid => {
    let g = next.get(l.leaf_id);
    if (!g) next.set(l.leaf_id, (g = pick(l.values, codes)));
    return g;
  };
  keys.forEach((key, i) => {
    const want = valueList[i]!;
    const id = Number(key.slice(2));
    if (key.startsWith('l:')) {
      const leaf = leafById.get(id)!;
      if (!sameGrid(leaf.values, want, codes)) next.set(id, { ...want });
      return;
    }
    const have = totals.get(id)!;
    const changed = codes.filter((c) => have[c] !== want[c]);
    if (changed.length === 0) return;
    const under = preorder(d, id).flatMap((n) => d.leavesByNode.get(n) ?? []);
    if (under.length === 0) throw bad(`${d.nodes.get(id)!.name} has no routes, so it cannot receive cases`);
    const leafKeys = under.map((l) => String(l.leaf_id));
    const grids = under.map(gridFor);
    for (const c of changed) {
      const scaled = rescale(under.map((l, j) => ({ key: leafKeys[j]!, value: l.values[c] ?? 0 })), want[c]!);
      for (let j = 0; j < under.length; j++) grids[j]![c] = scaled[leafKeys[j]!]!;
    }
  });
  const valueOf: LeafValue = (l) => next.get(l.leaf_id) ?? l.values;

  // ---- invariants, before anything is written ----
  // The subtree's leaves are every leaf loaded and the only leaves written, so
  // its per-pack total unchanged means the department's total is unchanged.
  const newTotals = subtreeTotals(d, nodeId, valueOf);
  const before = totals.get(nodeId)!;
  const after = newTotals.get(nodeId)!;
  keys.forEach((key, i) => {
    if (!key.startsWith('n:')) return;
    if (!sameGrid(newTotals.get(Number(key.slice(2)))!, valueList[i]!, codes)) {
      throw new Error(`submit invariant: ${key} does not add up to the submitted values`);
    }
  });
  for (const c of codes) {
    if (before[c] !== after[c]) throw new Error(`submit invariant: total of ${c} would change from ${before[c]} to ${after[c]}`);
  }
  for (const g of next.values()) {
    for (const c of codes) if (!Number.isInteger(g[c]) || g[c]! < 0) throw new Error(`submit invariant: invalid cases for ${c}`);
  }

  // ---- write: ONE atomic batch, every statement guarded by the version read ----
  const now = new Date().toISOString();
  const g = guard(monthId, nodeId, node.version, 'in_progress');
  const stmts: D1PreparedStatement[] = [];
  const changedLeaves = [...next.entries()]
    .filter(([id, grid]) => !sameGrid(leafById.get(id)!.values, grid, codes))
    .map(([id, v]) => ({ id, v }));
  for (let i = 0; i < changedLeaves.length; i += LEAF_UPDATE_CHUNK) {
    stmts.push(updateLeavesIf(db, g, monthId, changedLeaves.slice(i, i + LEAF_UPDATE_CHUNK)));
  }
  // Task 12: a child with a held_status (reopen path) goes through
  // restoreOrReopen instead; until then every child node gets a fresh turn.
  const childIds = d.childNodes.get(nodeId) ?? [];
  if (childIds.length) {
    const items = childIds.map((id) => ({ id, b: childTotalsOf(d, id, newTotals, valueOf) }));
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
