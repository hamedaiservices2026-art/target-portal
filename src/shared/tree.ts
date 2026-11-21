// Pure helpers over a flat node list ({id, parent_id}). No I/O, no D1.

export type TreeNode = { id: number; parent_id: number | null };

function parentMap(nodes: readonly TreeNode[]): Map<number, number | null> {
  return new Map(nodes.map((n) => [n.id, n.parent_id]));
}

/** Every node below `id` (children, grandchildren, ...), excluding `id`. */
export function descendants(nodes: readonly TreeNode[], id: number): number[] {
  const children = new Map<number, number[]>();
  for (const n of nodes) {
    if (n.parent_id === null) continue;
    const list = children.get(n.parent_id);
    if (list) list.push(n.id);
    else children.set(n.parent_id, [n.id]);
  }
  const out: number[] = [];
  const seen = new Set<number>([id]);
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    stack.push(...(children.get(cur) ?? []));
  }
  return out;
}

/** Parent first, root last, excluding `id`. [] for a root or unknown id. */
export function ancestors(nodes: readonly TreeNode[], id: number): number[] {
  const parents = parentMap(nodes);
  const out: number[] = [];
  const seen = new Set<number>([id]);
  let cur = parents.get(id) ?? null;
  while (cur !== null && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = parents.get(cur) ?? null;
  }
  return out;
}

/**
 * Lowest node that is `a`, `b`, or an ancestor of both. A node counts as its
 * own ancestor (LCA of a node and its descendant is the node). null when the
 * two are in different trees (departments) or either id is unknown.
 */
export function lowestCommonAncestor(nodes: readonly TreeNode[], a: number, b: number): number | null {
  const known = new Set(nodes.map((n) => n.id));
  if (!known.has(a) || !known.has(b)) return null;
  const chainA = [a, ...ancestors(nodes, a)];
  const inB = new Set([b, ...ancestors(nodes, b)]);
  for (const id of chainA) if (inB.has(id)) return id;
  return null;
}

/** True when `id` is `rootId` or lies anywhere below it. */
export function isInBranch(nodes: readonly TreeNode[], rootId: number, id: number): boolean {
  return id === rootId || ancestors(nodes, id).includes(rootId);
}
