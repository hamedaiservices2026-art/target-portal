// Regression guard for the free plan's ~10 ms CPU budget (controller ruling on
// Task 11): the in-memory side of the worst head-level submit (every pack of
// 2,000 leaves x 42 packs rescaled) must stay fast. Typical: a few ms; the bound
// is deliberately generous (100 ms) so the test is never flaky on a slow CI box,
// while a gross regression (the first object-grid version took ~90 ms here) fails it.
// plan.ts is pure (no D1), so it runs here in the node project.
import { describe, expect, it } from 'vitest';
import { capFor } from '../../src/shared/rules';
import {
  buildTree, childKeys, compactLeaves, leafPayload, planSubmit, subtreeTotals, type NodeRow,
} from '../../src/worker/services/plan';

const codes = Array.from({ length: 42 }, (_, i) => `CSD_PACK${String(i).padStart(2, '0')}`);

function fixture() {
  const nodes: NodeRow[] = [];
  const node = (id: number, parent: number | null) => nodes.push({
    node_id: id, parent_id: parent, name: `n${id}`, manager_user_id: null, manager_name: null,
    status: parent === null ? 'in_progress' : 'waiting', held_status: null, baseline_json: null, draft_json: null, version: 1,
  });
  node(1, null);
  const sups: number[] = [];
  for (let a = 0; a < 5; a++) {
    node(10 + a, 1);
    for (let s = 0; s < 5; s++) { node(100 + a * 10 + s, 10 + a); sups.push(100 + a * 10 + s); }
  }
  const rows = Array.from({ length: 2000 }, (_, i) => [
    i + 1, sups[i % sups.length]!, `R${i}`, `S${i}`, codes.map((_, j) => 50 + ((i * 7 + j * 13) % 300)),
  ]);
  const chunks: string[] = [];
  for (let i = 0; i < rows.length; i += 500) chunks.push(JSON.stringify(rows.slice(i, i + 500)));
  return { nodes, chunks };
}

describe('head-level submit plan, 2,000 leaves x 42 packs', () => {
  it('rescales every pack of every leaf well within budget and keeps every total', () => {
    const { nodes, chunks } = fixture();
    const run = () => {
      const t = buildTree(codes, nodes, compactLeaves(chunks));
      const totals = subtreeTotals(t, 1);
      const keys = childKeys(t, 1);
      const values = keys.map((k) => Array.from(totals.get(Number(k.slice(2)))!));
      const root = totals.get(1)!;
      codes.forEach((_, p) => {
        const cap = capFor(root[p]!, 5);
        values[0]![p]! -= cap;
        values[1]![p]! += cap - 3 * Math.floor(cap / 4);
        for (let a = 2; a < 5; a++) values[a]![p]! += Math.floor(cap / 4);
      });
      const plan = planSubmit(t, 1, keys, values, totals);
      const rows = [...plan.next.values()];
      for (let i = 0; i < rows.length; i += 500) leafPayload(rows.slice(i, i + 500));
      return { t, totals, keys, values, plan };
    };
    run(); // warm-up
    const t0 = performance.now();
    const { t, totals, keys, values, plan } = run();
    const ms = performance.now() - t0;

    expect(plan.next.size).toBe(2000);
    const after = plan.newTotals.get(1)!;
    codes.forEach((_, p) => expect(after[p]).toBe(totals.get(1)![p]));
    keys.forEach((k, i) => expect(Array.from(plan.newTotals.get(Number(k.slice(2)))!)).toEqual(values[i]));
    for (const row of plan.next.values()) for (let p = 1; p < row.length; p++) expect(Number.isInteger(row[p]) && row[p]! >= 0).toBe(true);
    expect(t.leaves).toHaveLength(2000);
    expect(ms).toBeLessThan(100);
  });
});
