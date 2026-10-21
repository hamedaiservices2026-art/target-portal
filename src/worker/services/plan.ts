// Pure in-memory side of distribution (no D1): the month tree, per-pack
// vectors, subtree totals and the submit plan. distribution.ts does the I/O.
//
// CPU (free plan, ~10 ms per request): grids are plain number arrays indexed
// by snapshot pack position (what JSON.parse returns, and what JSON.stringify
// writes natively), so sums are plain indexed loads; leaves arrive
// from SQLite as compact number arrays (`[50,63,...]`, see distribution.ts)
// and leave as the same, so the Worker never parses or builds the
// `{"CSD_PET1000":50,...}` objects of month_leaves.values_json. Rescaling
// reuses one Rescaler per child across all packs; ties (after fraction and
// value) go to the lower leaf id.
import { Rescaler } from '../../shared/scaling';
import type { ChildKey, Grid, NodeStatus } from '../../shared/types';

export type MonthPack = { code: string; grp: string; sort: number };
export type Vec = number[];

export type NodeRow = {
  node_id: number; parent_id: number | null; name: string; manager_user_id: number | null; manager_name: string | null;
  status: NodeStatus; held_status: string | null; baseline_json: string | null; draft_json: string | null; version: number;
};
export type LeafRow = { leaf_id: number; node_id: number; route_code: string; salesman_id: string | null; v: Vec };

/** A leaf as read: `v` holds the values in snapshot pack order, or (fallback) `values_json` is the stored object. */
export type RawLeaf = { leaf_id: number; node_id: number; route_code: string; salesman_id: string | null; v?: number[]; values_json?: string };

/** Parses the compact read: chunks of `[[leaf_id, node_id, route_code, salesman_id, [v0, ...]], ...]`. */
export function compactLeaves(chunks: string[]): RawLeaf[] {
  const out: RawLeaf[] = [];
  for (const chunk of chunks) {
    for (const r of JSON.parse(chunk) as [number, number, string, string | null, number[]][]) {
      out.push({ leaf_id: r[0], node_id: r[1], route_code: r[2], salesman_id: r[3], v: r[4] });
    }
  }
  return out;
}

export interface Tree {
  codes: string[];
  /** Every month_node of the department. */
  nodes: Map<number, NodeRow>;
  /** parent -> child node ids, in the order given (by name). */
  childNodes: Map<number, number[]>;
  /** node -> its direct leaves (only the leaves that were loaded), in the order given (by route code). */
  leavesByNode: Map<number, LeafRow[]>;
  leaves: LeafRow[];
}

export function buildTree(codes: string[], nodeRows: NodeRow[], leafRows: RawLeaf[]): Tree {
  const nodes = new Map<number, NodeRow>();
  const childNodes = new Map<number, number[]>();
  for (const n of nodeRows) {
    nodes.set(n.node_id, n);
    if (n.parent_id !== null) {
      const list = childNodes.get(n.parent_id);
      if (list) list.push(n.node_id);
      else childNodes.set(n.parent_id, [n.node_id]);
    }
  }
  const P = codes.length;
  const leaves: LeafRow[] = [];
  const leavesByNode = new Map<number, LeafRow[]>();
  for (const r of leafRows) {
    let leaf: LeafRow;
    if (r.v) {
      if (r.v.length !== P) throw new Error(`leaf ${r.leaf_id}: expected ${P} pack values, got ${r.v.length}`);
      leaf = r as LeafRow; // a compact leaf already has the LeafRow shape
    } else {
      const v = vecOf(JSON.parse(r.values_json ?? '{}') as Grid, codes);
      leaf = { leaf_id: r.leaf_id, node_id: r.node_id, route_code: r.route_code, salesman_id: r.salesman_id, v };
    }
    leaves.push(leaf);
    const list = leavesByNode.get(r.node_id);
    if (list) list.push(leaf);
    else leavesByNode.set(r.node_id, [leaf]);
  }
  return { codes, nodes, childNodes, leavesByNode, leaves };
}

// ---------- vectors ----------

/** Grid -> vector in pack order; missing packs read as 0. */
export function vecOf(g: Grid | undefined, codes: string[]): Vec {
  const v = new Array<number>(codes.length);
  for (let i = 0; i < codes.length; i++) v[i] = g?.[codes[i]!] ?? 0;
  return v;
}

export function gridOf(v: ArrayLike<number>, codes: string[]): Grid {
  const g: Grid = {};
  for (let i = 0; i < codes.length; i++) g[codes[i]!] = v[i]!;
  return g;
}

function sameVec(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------- tree walks ----------

/** Node ids of `rootId`'s subtree in pre-order (children in their order), including `rootId`. */
export function preorder(t: Tree, rootId: number): number[] {
  const out: number[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    const kids = t.childNodes.get(id);
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return out;
}

/** Per-pack sums (Float64Array: plain indexed adds, no element-kind changes). */
export type Sums = Float64Array;

/**
 * A changed leaf: `[leafId, v0, v1, ...]` (pack p at index p + 1). It is both
 * the plan's new vector and, unchanged, a row of the leaf UPDATE payload.
 */
export type Row = number[];

/** Σ of the loaded leaves per node of `rootId`'s subtree; `next` overrides leaf vectors. One post-order pass. */
export function subtreeTotals(t: Tree, rootId: number, next?: Map<number, Row>): Map<number, Sums> {
  const P = t.codes.length;
  const order = preorder(t, rootId);
  const totals = new Map<number, Sums>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    const sum = new Float64Array(P);
    for (const l of t.leavesByNode.get(id) ?? []) {
      const row = next && next.get(l.leaf_id);
      if (row) for (let p = 0; p < P; p++) sum[p]! += row[p + 1]!;
      else for (let p = 0, v = l.v; p < P; p++) sum[p]! += v[p]!;
    }
    for (const k of t.childNodes.get(id) ?? []) {
      const v = totals.get(k)!;
      for (let p = 0; p < P; p++) sum[p]! += v[p]!;
    }
    totals.set(id, sum);
  }
  return totals;
}

/** Child nodes (in order) then direct leaves (in order). */
export function childKeys(t: Tree, nodeId: number): ChildKey[] {
  return [
    ...(t.childNodes.get(nodeId) ?? []).map((id) => `n:${id}` as ChildKey),
    ...(t.leavesByNode.get(nodeId) ?? []).map((l) => `l:${l.leaf_id}` as ChildKey),
  ];
}

/** Each child's grid: a child node's subtree total, a child leaf's own values. */
export function childGrids(t: Tree, nodeId: number, totals: Map<number, Sums>, next?: Map<number, Row>): Record<ChildKey, Grid> {
  const out: Record<ChildKey, Grid> = {};
  for (const id of t.childNodes.get(nodeId) ?? []) out[`n:${id}`] = gridOf(totals.get(id)!, t.codes);
  for (const l of t.leavesByNode.get(nodeId) ?? []) {
    const row = next?.get(l.leaf_id);
    out[`l:${l.leaf_id}`] = row ? gridOf(row.slice(1), t.codes) : gridOf(l.v, t.codes);
  }
  return out;
}

// ---------- submit plan ----------

/** A child node with no routes cannot receive cases. */
export class NoRoutesError extends Error {
  constructor(readonly nodeName: string) {
    super(`${nodeName} has no routes, so it cannot receive cases`);
  }
}

export interface SubmitPlan {
  /** New rows of the leaves that change (and only those). */
  next: Map<number, Row>;
  /** Subtree totals with the new values. */
  newTotals: Map<number, Sums>;
}

/**
 * Applies the submitted child values (`values[i]` for `keys[i]`, already
 * rule-checked): a child leaf takes its vector; for a child node every pack
 * whose total changes is rescaled over the leaves of its subtree. Throws
 * NoRoutesError, or Error when an invariant fails (nothing has been written:
 * the caller writes only after this returns):
 *   every child node's new subtree total = its submitted values,
 *   the subtree's per-pack total is unchanged, every value is whole and >= 0.
 */
export function planSubmit(t: Tree, nodeId: number, keys: ChildKey[], values: Vec[], totals: Map<number, Sums>): SubmitPlan {
  const P = t.codes.length;
  const next = new Map<number, Row>();
  const ownLeaves = new Map((t.leavesByNode.get(nodeId) ?? []).map((l) => [l.leaf_id, l]));
  const bad = (code: string) => new Error(`submit invariant: invalid cases for ${code}`);
  // Scratch for the column copies and results, sized for the largest child, reused.
  let scratch = new Float64Array(0);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const want = values[i]!;
    const id = Number(key.slice(2));
    if (key.startsWith('l:')) {
      for (let p = 0; p < P; p++) if (!Number.isInteger(want[p]) || want[p]! < 0) throw bad(t.codes[p]!);
      if (!sameVec(ownLeaves.get(id)!.v, want)) next.set(id, [id].concat(want));
      continue;
    }
    const have = totals.get(id)!;
    const changed: number[] = [];
    for (let p = 0; p < P; p++) if (have[p] !== want[p]) changed.push(p);
    if (changed.length === 0) continue;
    const under = preorder(t, id).flatMap((n) => t.leavesByNode.get(n) ?? []);
    if (under.length === 0) throw new NoRoutesError(t.nodes.get(id)!.name);
    const n = under.length;
    const C = changed.length;
    // Column-major copy of the changed packs (one pass over the leaves), one
    // rescale per column, then the results go into each leaf's new row
    // column by column (contiguous reads).
    if (scratch.length < 2 * C * n) scratch = new Float64Array(2 * C * n);
    const cols = scratch.subarray(0, C * n);
    for (let j = 0; j < n; j++) {
      const v = under[j]!.v;
      for (let c = 0; c < C; c++) cols[c * n + j] = v[changed[c]!]!;
    }
    const outs = scratch.subarray(C * n, 2 * C * n);
    // Ties after fraction and value go to the lower leaf id (no key strings, no sort).
    const rescaler = Rescaler.byOrder(under.map((l) => l.leaf_id));
    for (let c = 0; c < C; c++) {
      rescaler.scale(cols.subarray(c * n, c * n + n), want[changed[c]!]!, outs.subarray(c * n, c * n + n));
    }
    const rows: Row[] = new Array(n);
    for (let j = 0; j < n; j++) rows[j] = [under[j]!.leaf_id].concat(under[j]!.v);
    const differs = new Uint8Array(n);
    for (let c = 0; c < C; c++) {
      const p = changed[c]!;
      const base = c * n;
      for (let j = 0; j < n; j++) {
        const x = outs[base + j]!;
        if (!Number.isInteger(x) || x < 0) throw bad(t.codes[p]!);
        const row = rows[j]!;
        if (x !== row[p + 1]) {
          // Small integers are stored as SMIs (`x | 0`): the array stays an
          // integer array, which JSON.stringify writes much faster than doubles.
          row[p + 1] = x < 0x3fffffff ? x | 0 : x;
          differs[j] = 1;
        }
      }
    }
    // A rescale can leave a leaf exactly as it was: nothing to write for it.
    for (let j = 0; j < n; j++) if (differs[j]) next.set(under[j]!.leaf_id, rows[j]!);
  }
  const newTotals = subtreeTotals(t, nodeId, next);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (key.startsWith('n:') && !sameVec(newTotals.get(Number(key.slice(2)))!, values[i]!)) {
      throw new Error(`submit invariant: ${key} does not add up to the submitted values`);
    }
  }
  const before = totals.get(nodeId)!;
  const after = newTotals.get(nodeId)!;
  for (let p = 0; p < P; p++) {
    if (before[p] !== after[p]) throw new Error(`submit invariant: total of ${t.codes[p]} would change from ${before[p]} to ${after[p]}`);
  }
  return { next, newTotals };
}

/** `[[leafId, v0, v1, ...], ...]` for the set-based leaf UPDATE (values are whole numbers). */
export function leafPayload(rows: Row[]): string {
  return JSON.stringify(rows);
}
