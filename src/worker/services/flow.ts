// Month flow. Task 12 replaces applyTreeChangeToOpenMonths with the real
// propagation of live-tree edits into open months.

export type TreeChange =
  | { kind: 'move_leaf' | 'move_node'; id: number; fromParent: number; toParent: number }
  | { kind: 'manager'; nodeId: number; userId: number | null };

export type TreeChangeResult = { appliedMonths: number[]; skippedMonths: number[] };

/** Stub until Task 12: no month is touched. */
export async function applyTreeChangeToOpenMonths(_db: D1Database, _change: TreeChange): Promise<TreeChangeResult> {
  return { appliedMonths: [], skippedMonths: [] };
}
