import { describe, expect, it } from 'vitest';
import { averageSales, sumSeries } from '../../../src/shared/calc/averages';
import { fitAndRound, fitMatrix, FitError } from '../../../src/shared/calc/fit';
import { channelSplit, departmentSplit, gap } from '../../../src/shared/calc/splits';
import { cascade, reconcile, type CascadeNode } from '../../../src/shared/calc/cascade';
import { checkPackRules, rebalanceGroup } from '../../../src/shared/calc/distribution';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rowSums = (m: number[][]) => m.map((r) => r.reduce((a, b) => a + b, 0));
const colSums = (m: number[][]) => m[0]!.map((_, j) => m.reduce((s, r) => s + r[j]!, 0));

describe('averageSales', () => {
  it('skips missing months like Excel AVERAGE, counts zeros', () => {
    expect(averageSales({ '2026-07': 90, '2026-09': 30 }, ['2026-07', '2026-08', '2026-09'])).toEqual({ avg: 60, count: 2 });
    expect(averageSales({ '2026-07': 90, '2026-08': 0, '2026-09': 30 }, ['2026-07', '2026-08', '2026-09'])).toEqual({ avg: 40, count: 3 });
    expect(averageSales(undefined, ['2026-07'])).toEqual({ avg: 0, count: 0 });
  });

  it('sums series month by month', () => {
    expect(sumSeries([{ '2026-07': 1 }, { '2026-07': 2, '2026-08': 5 }])).toEqual({ '2026-07': 3, '2026-08': 5 });
  });
});

describe('fit', () => {
  it('rows and columns add up exactly after rounding', () => {
    const out = fitAndRound([[10, 20, 30], [5, 5, 5], [1, 0, 9]], [101, 37, 12], [40, 50, 60]);
    expect(rowSums(out)).toEqual([101, 37, 12]);
    expect(colSums(out)).toEqual([40, 50, 60]);
    expect(out.flat().every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
    expect(out[2]![1]).toBe(0); // a zero seed cell stays zero
  });

  it('holds on random matrices', () => {
    const rnd = mulberry32(7);
    for (let n = 0; n < 200; n++) {
      const R = 1 + Math.floor(rnd() * 8);
      const C = 1 + Math.floor(rnd() * 6);
      const seed = Array.from({ length: R }, () => Array.from({ length: C }, () => (rnd() < 0.2 ? 0 : rnd() * 1000)));
      const rows = Array.from({ length: R }, () => Math.floor(rnd() * 5000));
      const total = rows.reduce((a, b) => a + b, 0);
      const w = Array.from({ length: C }, () => rnd());
      const ws = w.reduce((a, b) => a + b, 0);
      const cols = w.map((x) => Math.floor((x / ws) * total));
      cols[0]! += total - cols.reduce((a, b) => a + b, 0);
      const out = fitAndRound(seed, rows, cols);
      expect(rowSums(out)).toEqual(rows);
      expect(colSums(out)).toEqual(cols);
    }
  });

  it('seeds an empty row that has a target', () => {
    const out = fitAndRound([[0, 0], [3, 1]], [10, 10], [12, 8]);
    expect(rowSums(out)).toEqual([10, 10]);
    expect(colSums(out)).toEqual([12, 8]);
  });

  it('refuses margins that disagree', () => {
    expect(() => fitMatrix([[1]], [5], [6])).toThrow(FitError);
  });
});

describe('departmentSplit (step A)', () => {
  const depts = ['TT', 'MT', 'WS'];
  const none = {};
  it('splits by (3-month avg + PAGO) / 2 of the pack', () => {
    const r = departmentSplit({
      newTarget: 1000, depts,
      packAvg3: { TT: 600, MT: 300, WS: 100 }, packPago: { TT: 400, MT: 300, WS: 300 },
      catAvg3: none, catPago: none, pagoTarget: none,
    });
    // weights 500 / 300 / 200
    expect(r).toEqual({ alloc: { TT: 500, MT: 300, WS: 200 }, basis: 'pack_sales' });
  });

  it('falls back to category sales, then PAGO target, then equal', () => {
    const base = { newTarget: 10, depts, packAvg3: none, packPago: none };
    expect(departmentSplit({ ...base, catAvg3: { TT: 1 }, catPago: { TT: 1 }, pagoTarget: { MT: 5 } }).basis).toBe('category_sales');
    expect(departmentSplit({ ...base, catAvg3: none, catPago: none, pagoTarget: { MT: 5 } })).toEqual({ alloc: { TT: 0, MT: 10, WS: 0 }, basis: 'pago_target' });
    expect(departmentSplit({ ...base, catAvg3: none, catPago: none, pagoTarget: none })).toEqual({ alloc: { TT: 3, MT: 4, WS: 3 }, basis: 'equal' });
  });

  it('uses the uploaded split as is, or rescales it when the New Target changed', () => {
    const base = { depts, packAvg3: { TT: 1 }, packPago: none, catAvg3: none, catPago: none, pagoTarget: none };
    expect(departmentSplit({ ...base, newTarget: 100, uploaded: { TT: 50, MT: 30, WS: 20 } })).toEqual({ alloc: { TT: 50, MT: 30, WS: 20 }, basis: 'uploaded' });
    expect(departmentSplit({ ...base, newTarget: 200, uploaded: { TT: 50, MT: 30, WS: 20 } })).toEqual({ alloc: { TT: 100, MT: 60, WS: 40 }, basis: 'uploaded_rescaled' });
  });
});

describe('channelSplit (step B)', () => {
  it('splits by PAGO channel target with fallbacks', () => {
    const ch = ['MT', 'MT SSV', 'MT Bulk'];
    expect(channelSplit({ total: 100, channels: ch, packPago: { MT: 70, 'MT SSV': 20, 'MT Bulk': 10 }, catPago: {}, allPago: {} }).alloc).toEqual({ MT: 70, 'MT SSV': 20, 'MT Bulk': 10 });
    expect(channelSplit({ total: 10, channels: ch, packPago: {}, catPago: {}, allPago: { MT: 1, 'MT SSV': 1 } })).toEqual({ alloc: { MT: 5, 'MT SSV': 5, 'MT Bulk': 0 }, basis: 'all_pago' });
    expect(channelSplit({ total: 7, channels: ['HoReCa'], packPago: {}, catPago: {}, allPago: {} }).alloc).toEqual({ HoReCa: 7 });
  });

  it('gap', () => {
    expect(gap(110, 100)).toBeCloseTo(0.1);
    expect(gap(5, 0)).toBeNull();
  });
});

describe('cascade (step D)', () => {
  const tree: CascadeNode = {
    id: 'H', children: [
      { id: 'M1', children: [{ id: 'S1', children: [{ id: 'r1', children: [] }, { id: 'r2', children: [] }] }] },
      { id: 'M2', children: [{ id: 'S2', children: [{ id: 'r3', children: [] }] }] },
    ],
  };
  const sales: Record<string, Record<string, number>> = { r1: { A: 30 }, r2: { A: 10 }, r3: { A: 60 } };

  it('splits each level by the pack sales under each child and adds up exactly', () => {
    const r = cascade({
      root: tree, packs: ['A', 'B'], target: { A: 1001, B: 9 },
      packAvg: (rt, p) => sales[rt]?.[p] ?? 0,
      categoryAvg: (rt) => ({ r1: 0, r2: 0, r3: 0 })[rt] ?? 0,
      routeTarget: (rt, p) => (p === 'B' && rt === 'r2' ? 3 : 0),
    });
    expect(r.nodes.M1!.A! + r.nodes.M2!.A!).toBe(1001);
    expect(r.routes.r1!.A! + r.routes.r2!.A! + r.routes.r3!.A!).toBe(1001);
    expect(r.routes.r3!.A).toBe(601);
    // B has no sales anywhere: falls back to the uploaded route target (only r2) -> all 9 to r2.
    expect(r.routes.r2!.B).toBe(9);
    expect(r.fallbackPacks.route_target).toEqual(['B']);
  });

  it('reconciles department totals and the ABC cap', () => {
    const ok = reconcile([{ dept: 'TT', category: 'CSD', target: 100, calculated: 101 }], 200);
    expect(ok.ok).toBe(true);
    const bad = reconcile([{ dept: 'TT', category: 'CSD', target: 100, calculated: 98 }, { dept: 'MT', category: 'CSD', target: 100, calculated: 103 }], 200);
    expect(bad.ok).toBe(false);
    expect(bad.overAbc).toBe(1);
  });
});

describe('distribution rules', () => {
  const on = { capPct: 5, rule2: true, rule3: true };
  it('owner examples: 1000 split 700/300 may go to 650/350, not 640/360', () => {
    expect(checkPackRules(1000, [700, 300], [650, 350], on).status).toBe('ok');
    expect(checkPackRules(1000, [700, 300], [640, 360], on).status).toBe('person_over_cap');
  });

  it('rule 3 blocks moving 100 across four people even when nobody moved more than 50', () => {
    const r = checkPackRules(1000, [250, 250, 250, 250], [200, 200, 300, 300], on);
    expect(r.status).toBe('moved_too_much');
    expect(checkPackRules(1000, [250, 250, 250, 250], [200, 200, 300, 300], { ...on, rule3: false }).status).toBe('ok');
  });

  it('a per-person exception cap', () => {
    expect(checkPackRules(1000, [700, 300], [640, 360], { ...on, rule3: false }, [10, undefined]).status).toBe('person_over_cap');
    expect(checkPackRules(1000, [700, 300], [640, 360], { ...on, rule3: false }, [10, 10]).status).toBe('ok');
  });

  it('rule 1 is always on; packs under 20 cases cannot move at 5%', () => {
    expect(checkPackRules(100, [50, 50], [50, 49], { ...on, rule2: false, rule3: false }).status).toBe('short');
    expect(checkPackRules(19, [10, 9], [9, 10], on).status).toBe('person_over_cap');
  });
});

describe('rebalanceGroup (By total)', () => {
  it('keeps every pack at its locked target and gives the person the new group total', () => {
    const totals = [1000, 500, 0];
    const values = [[600, 400], [200, 300], [0, 0]];
    const out = rebalanceGroup(totals, values, 0, 760);
    expect(out.map((r) => r[0]!).reduce((a, b) => a + b, 0)).toBe(760);
    out.forEach((r, p) => expect(r.reduce((a, b) => a + b, 0)).toBe(totals[p]));
  });

  it('never gives a person more than a pack target', () => {
    const out = rebalanceGroup([10, 1000], [[5, 5], [10, 990]], 0, 500);
    expect(out[0]![0]).toBeLessThanOrEqual(10);
    expect(out[0]![0]! + out[1]![0]!).toBe(500);
  });

  it('refuses a total above the group target', () => {
    expect(() => rebalanceGroup([10], [[5, 5]], 0, 11)).toThrow();
  });
});
