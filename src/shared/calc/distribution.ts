/**
 * The "By total" rebalance of the distribution page (handover section 7).
 * Pure module. The rule checks themselves live in ../rules.ts (checkPack with
 * RuleOptions: rules 2 and 3 switchable, per-person cap exceptions).
 */
import { largestRemainder } from '../rounding';

export class RebalanceError extends Error {}

/**
 * "By total" view: person `who` types a new total for a summary group. Their
 * packs in the group are rescaled to that total in proportion to their current
 * values (never above a pack's locked target), and in each pack the difference
 * is taken from / given to the other people in proportion to their current
 * values, so every pack still adds up to its locked target.
 *
 * `values[p][i]` = person i's cases of pack p (only the group's packs).
 * Returns a new matrix; the caller re-runs the rule checks on it.
 */
export function rebalanceGroup(
  totals: readonly number[],
  values: readonly (readonly number[])[],
  who: number,
  newGroupTotal: number,
): number[][] {
  const P = totals.length;
  if (values.length !== P) throw new RebalanceError('values must have one row per pack');
  const people = values[0]?.length ?? 0;
  if (who < 0 || who >= people) throw new RebalanceError('unknown person');
  if (!Number.isInteger(newGroupTotal) || newGroupTotal < 0) throw new RebalanceError('the new total must be whole cases >= 0');
  const capacity = totals.reduce((a, b) => a + b, 0);
  if (newGroupTotal > capacity) throw new RebalanceError(`the new total ${newGroupTotal} is more than the group's target ${capacity}`);
  if (people === 1 && newGroupTotal !== capacity) throw new RebalanceError('with one person the group total is locked');

  // 1. The person's new pack values: proportional, bounded by each pack target.
  const cur = values.map((r) => r[who] ?? 0);
  const base = cur.some((v) => v > 0) ? cur : [...totals];
  const mine = new Array<number>(P).fill(0);
  let free = Array.from({ length: P }, (_, p) => p).filter((p) => totals[p]! > 0);
  let left = newGroupTotal;
  while (left > 0 && free.length > 0) {
    const w = free.some((p) => base[p]! > 0) ? free.map((p) => base[p]!) : free.map((p) => totals[p]!);
    const alloc = largestRemainder(free.map((p, k) => ({ key: String(p).padStart(6, '0'), value: w[k]! })), left);
    const clamped: number[] = [];
    left = 0;
    for (const p of free) {
      const want = mine[p]! + alloc[String(p).padStart(6, '0')]!;
      if (want >= totals[p]!) {
        left += want - totals[p]!;
        mine[p] = totals[p]!;
        clamped.push(p);
      } else mine[p] = want;
    }
    if (clamped.length === 0) break;
    free = free.filter((p) => !clamped.includes(p));
  }

  // 2. Everyone else, pack by pack.
  return values.map((row, p) => {
    const rest = totals[p]! - mine[p]!;
    const others = row.map((v, i) => ({ key: String(i).padStart(6, '0'), value: i === who ? 0 : v }));
    const othersOnly = others.filter((_, i) => i !== who);
    const split = largestRemainder(othersOnly, rest);
    return row.map((_, i) => (i === who ? mine[p]! : split[String(i).padStart(6, '0')]!));
  });
}
