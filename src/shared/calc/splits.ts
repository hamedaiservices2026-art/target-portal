/**
 * Department and channel splits of the New Target (handover section 6, steps
 * A and B). Pure module. Every split is whole cases by largest remainder, so
 * the parts add up exactly to the pack's New Target.
 */
import { largestRemainder } from '../rounding';

export type Weights = Readonly<Record<string, number | undefined>>;

function clean(v: number | undefined): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Whole-case split of `total` over `keys` by `weights` (equal when all weights are 0). */
export function splitByWeights(total: number, keys: readonly string[], weights: Weights): Record<string, number> {
  return largestRemainder(keys.map((k) => ({ key: k, value: clean(weights[k]) })), total);
}

function anyPositive(keys: readonly string[], w: Weights): boolean {
  return keys.some((k) => clean(w[k]) > 0);
}

/** The department weight for one pack: (3-month avg sales + PAGO sales) / 2. */
export function salesWeight(avg3: number | undefined, pagoSales: number | undefined): number {
  return (clean(avg3) + clean(pagoSales)) / 2;
}

/** Which rule set the department split of a pack. Shown to the CD as the "basis". */
export type DeptBasis = 'uploaded' | 'uploaded_rescaled' | 'pack_sales' | 'category_sales' | 'pago_target' | 'equal';

export interface DeptSplitInput {
  newTarget: number;
  depts: readonly string[];
  /** 3-month average sales of this pack, by department. */
  packAvg3: Weights;
  /** PAGO sales of this pack, by department. */
  packPago: Weights;
  /** 3-month average sales of the pack's whole category, by department. */
  catAvg3: Weights;
  /** PAGO sales of the pack's whole category, by department. */
  catPago: Weights;
  /** PAGO department target of this pack. */
  pagoTarget: Weights;
  /**
   * The admin's "by pack & department" upload for this pack (step 2B), when
   * there is one. Used as is when it adds up to newTarget, else rescaled in
   * the same proportions.
   */
  uploaded?: Weights;
}

export interface DeptSplit {
  alloc: Record<string, number>;
  basis: DeptBasis;
}

/**
 * Step A: New Target of one pack -> departments.
 * Weight = (3-month avg sales + PAGO sales) / 2 of the pack; fallbacks when
 * every department has zero: the same formula on the whole category, then the
 * PAGO department target of the pack, then an equal split.
 */
export function departmentSplit(inp: DeptSplitInput): DeptSplit {
  const { newTarget, depts } = inp;
  if (inp.uploaded && anyPositive(depts, inp.uploaded)) {
    const upSum = depts.reduce((s, d) => s + clean(inp.uploaded![d]), 0);
    const exact = upSum === newTarget && depts.every((d) => Number.isInteger(clean(inp.uploaded![d])));
    if (exact) {
      return { alloc: Object.fromEntries(depts.map((d) => [d, clean(inp.uploaded![d])])), basis: 'uploaded' };
    }
    return { alloc: splitByWeights(newTarget, depts, inp.uploaded), basis: 'uploaded_rescaled' };
  }
  const pack: Record<string, number> = {};
  for (const d of depts) pack[d] = salesWeight(inp.packAvg3[d], inp.packPago[d]);
  if (anyPositive(depts, pack)) return { alloc: splitByWeights(newTarget, depts, pack), basis: 'pack_sales' };
  const cat: Record<string, number> = {};
  for (const d of depts) cat[d] = salesWeight(inp.catAvg3[d], inp.catPago[d]);
  if (anyPositive(depts, cat)) return { alloc: splitByWeights(newTarget, depts, cat), basis: 'category_sales' };
  if (anyPositive(depts, inp.pagoTarget)) return { alloc: splitByWeights(newTarget, depts, inp.pagoTarget), basis: 'pago_target' };
  return { alloc: splitByWeights(newTarget, depts, {}), basis: 'equal' };
}

export type ChannelBasis = 'pack_pago' | 'category_pago' | 'all_pago' | 'equal';

export interface ChannelSplitInput {
  total: number;
  channels: readonly string[];
  /** PAGO department & channel target of this pack (step 7 file). */
  packPago: Weights;
  /** PAGO channel target of the pack's whole category. */
  catPago: Weights;
  /** PAGO channel target of everything. */
  allPago: Weights;
}

/**
 * Step B: a department's cases of one pack -> its channels (only for Heads
 * with several channels). Weights = PAGO department & channel target of the
 * pack; fallbacks: of the category, of everything, then equal.
 */
export function channelSplit(inp: ChannelSplitInput): { alloc: Record<string, number>; basis: ChannelBasis } {
  const { total, channels } = inp;
  if (channels.length === 1) return { alloc: { [channels[0]!]: total }, basis: 'pack_pago' };
  if (anyPositive(channels, inp.packPago)) return { alloc: splitByWeights(total, channels, inp.packPago), basis: 'pack_pago' };
  if (anyPositive(channels, inp.catPago)) return { alloc: splitByWeights(total, channels, inp.catPago), basis: 'category_pago' };
  if (anyPositive(channels, inp.allPago)) return { alloc: splitByWeights(total, channels, inp.allPago), basis: 'all_pago' };
  return { alloc: splitByWeights(total, channels, {}), basis: 'equal' };
}

/** Department channel key: `<Head ID>~~<channel>`; a Head's unassigned remainder is `<Head ID>~~_`. */
export function channelKey(headId: string, channel: string | null): string {
  return `${headId}~~${channel ?? '_'}`;
}

/** Recommended share of mix = (3-month average SOM + PAGO SOM) / 2. */
export function recommendedSom(avg3Som: number, pagoSom: number): number {
  return (avg3Som + pagoSom) / 2;
}

/** Gap = value / benchmark - 1, or null when the benchmark is 0. */
export function gap(value: number, benchmark: number): number | null {
  return benchmark > 0 ? value / benchmark - 1 : null;
}
