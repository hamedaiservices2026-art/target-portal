/**
 * Department target -> routes (handover section 6, step D: Admin > Target
 * calculator). Pure module.
 *
 * For each pack, cascade top-down through the hierarchy (Head -> managers ->
 * supervisors -> routes, or Head -> KAMs -> KAEs), each level split by the
 * 3-month average sales of that pack under each child. Fallbacks at each
 * level when every child has zero: the routes' total sales of the category,
 * then the uploaded route target of the pack, then equal per route.
 */
import { largestRemainder } from '../rounding';

export interface CascadeNode {
  id: string;
  /** Child nodes; empty for a route (leaf). */
  children: CascadeNode[];
}

export type CascadeBasis = 'pack_sales' | 'category_sales' | 'route_target' | 'equal';

export interface CascadeInput {
  root: CascadeNode;
  packs: readonly string[];
  /** Department target per pack (whole cases). */
  target: Readonly<Record<string, number>>;
  /** Route -> pack -> 3-month average sales. */
  packAvg: (routeId: string, pack: string) => number;
  /** Route -> category total average sales of the pack's category. */
  categoryAvg: (routeId: string, pack: string) => number;
  /** Route -> uploaded route target of the pack (monthly target file). */
  routeTarget: (routeId: string, pack: string) => number;
  /**
   * Admin edits: a node's (or route's) own cases of a pack. The siblings that
   * are not fixed share what is left of the parent's cases by their weights.
   */
  fixed?: (nodeId: string, pack: string) => number | undefined;
}

export interface CascadeIssue {
  /** The parent node whose children were fixed. */
  node: string;
  pack: string;
  /** over: fixed children exceed the parent's cases; short: every child fixed and cases are left over. */
  kind: 'over' | 'short';
  cases: number;
}

export interface CascadeResult {
  /** Route id -> pack -> cases. Every route gets every pack (0 included). */
  routes: Record<string, Record<string, number>>;
  /** Node id (non-leaf) -> pack -> cases the node received. */
  nodes: Record<string, Record<string, number>>;
  /** How many level splits used each basis (the notes shown to Admin). */
  basisCount: Record<CascadeBasis, number>;
  /** Packs where at least one split fell back from pack sales. */
  fallbackPacks: Record<Exclude<CascadeBasis, 'pack_sales'>, string[]>;
  /** Problems with the admin edits (empty without `fixed`). */
  issues: CascadeIssue[];
}

function pos(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

interface Prepared {
  node: CascadeNode;
  routes: string[];
}

function prepare(n: CascadeNode, out: Map<string, Prepared>, seen: Set<string>): string[] {
  if (seen.has(n.id)) throw new RangeError(`cascade: node "${n.id}" appears twice`);
  seen.add(n.id);
  const routes = n.children.length === 0 ? [n.id] : n.children.flatMap((c) => prepare(c, out, seen));
  out.set(n.id, { node: n, routes });
  return routes;
}

export function cascade(inp: CascadeInput): CascadeResult {
  const prep = new Map<string, Prepared>();
  prepare(inp.root, prep, new Set());
  const result: CascadeResult = {
    routes: {},
    nodes: {},
    basisCount: { pack_sales: 0, category_sales: 0, route_target: 0, equal: 0 },
    fallbackPacks: { category_sales: [], route_target: [], equal: [] },
    issues: [],
  };
  for (const { node } of prep.values()) {
    if (node.children.length === 0) result.routes[node.id] = {};
    else result.nodes[node.id] = {};
  }

  for (const pack of inp.packs) {
    const total = inp.target[pack] ?? 0;
    if (!Number.isInteger(total) || total < 0) throw new RangeError(`cascade: target of ${pack} must be whole cases >= 0, got ${total}`);
    const used = new Set<CascadeBasis>();
    const weightOf = (routes: string[], f: (r: string, p: string) => number) => routes.reduce((s, r) => s + pos(f(r, pack)), 0);

    const walk = (n: CascadeNode, amount: number): void => {
      if (n.children.length === 0) {
        result.routes[n.id]![pack] = amount;
        return;
      }
      result.nodes[n.id]![pack] = amount;
      const kids = n.children;
      const kidRoutes = kids.map((c) => prep.get(c.id)!.routes);
      let basis: CascadeBasis = 'pack_sales';
      let w = kidRoutes.map((rs) => weightOf(rs, inp.packAvg));
      if (!w.some((x) => x > 0)) {
        basis = 'category_sales';
        w = kidRoutes.map((rs) => weightOf(rs, inp.categoryAvg));
      }
      if (!w.some((x) => x > 0)) {
        basis = 'route_target';
        w = kidRoutes.map((rs) => weightOf(rs, inp.routeTarget));
      }
      if (!w.some((x) => x > 0)) {
        basis = 'equal';
        w = kidRoutes.map((rs) => rs.length);
      }
      if (amount > 0) {
        result.basisCount[basis] += 1;
        used.add(basis);
      }
      const fx = inp.fixed ? kids.map((c) => {
        const v = inp.fixed!(c.id, pack);
        return v !== undefined && Number.isInteger(v) && v >= 0 ? v : undefined;
      }) : [];
      if (fx.some((v) => v !== undefined)) {
        const fixedSum = fx.reduce<number>((s, v) => s + (v ?? 0), 0);
        let rest = amount - fixedSum;
        if (rest < 0) {
          result.issues.push({ node: n.id, pack, kind: 'over', cases: -rest });
          rest = 0;
        }
        const free = kids.map((c, i) => ({ c, i })).filter((x) => fx[x.i] === undefined);
        if (!free.length && rest > 0) result.issues.push({ node: n.id, pack, kind: 'short', cases: rest });
        const fw = free.map((x) => w[x.i]!);
        const any = fw.some((x) => x > 0);
        const split = free.length ? largestRemainder(free.map((x, j) => ({ key: x.c.id, value: any ? fw[j]! : kidRoutes[x.i]!.length })), rest) : {};
        kids.forEach((c, i) => walk(c, fx[i] ?? split[c.id] ?? 0));
        return;
      }
      const split = largestRemainder(kids.map((c, i) => ({ key: c.id, value: w[i]! })), amount);
      kids.forEach((c) => walk(c, split[c.id]!));
    };
    walk(inp.root, total);
    for (const b of used) if (b !== 'pack_sales') result.fallbackPacks[b].push(pack);
  }
  return result;
}

export interface ReconcileLine {
  dept: string;
  category: string;
  target: number;
  calculated: number;
  diff: number;
  ok: boolean;
}

/**
 * Reconciliation before applying (section 6): each department's calculated
 * total must equal its department target per category (tolerance: 1 case per
 * department per category), and the sum must not exceed the ABC company total.
 */
export function reconcile(
  lines: readonly { dept: string; category: string; target: number; calculated: number }[],
  abcTotal: number | null,
  tolerance = 1,
): { ok: boolean; lines: ReconcileLine[]; calculatedTotal: number; overAbc: number } {
  const out = lines.map((l) => {
    const diff = l.calculated - l.target;
    return { ...l, diff, ok: Math.abs(diff) <= tolerance };
  });
  const calculatedTotal = out.reduce((s, l) => s + l.calculated, 0);
  const overAbc = abcTotal === null ? 0 : Math.max(0, calculatedTotal - abcTotal);
  return { ok: out.every((l) => l.ok) && overAbc === 0, lines: out, calculatedTotal, overAbc };
}
