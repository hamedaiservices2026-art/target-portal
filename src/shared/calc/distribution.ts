/**
 * Distribution rules and the "By total" rebalance (handover sections 6 and 7).
 * Pure module.
 *
 * Rule 1 (always): every pack still adds up to its locked target.
 * Rule 2 (switchable): one person can change by at most their cap % of the
 *   pack target. A named person may have their own cap % (exception).
 * Rule 3 (switchable): total cases moved in a pack can't exceed the level's
 *   cap % of the pack target.
 * Caps are whole cases, rounded down: 5% of 19 = 0, so packs under 20 cases
 * can't move at a 5% cap.
 */
import { largestRemainder } from '../rounding';
import { capFor } from '../rules';

export interface RuleSettings {
  /** The level's cap % (Head, Manager or Supervisor; 5 by default). */
  capPct: number;
  rule2: boolean;
  rule3: boolean;
}

export type RuleStatus = 'ok' | 'over' | 'short' | 'person_over_cap' | 'moved_too_much' | 'invalid';

export interface RuleCheck {
  ok: boolean;
  status: RuleStatus;
  total: number;
  sum: number;
  /** sum - total. */
  diff: number;
  /** Sum of increases over the starting values. */
  moved: number;
  /** Rule 3 cap (level cap % of total). */
  cap: number;
  /** Rule 2 cap per person (exceptions applied). */
  personCaps: number[];
  /** Indexes of people over their own cap (rule 2), whether or not rule 2 is on. */
  overCap: number[];
}

function whole(n: number | undefined): n is number {
  return n !== undefined && Number.isInteger(n) && n >= 0;
}

/**
 * Checks one pack. `personCapPct[i]` is person i's own cap % (an exception),
 * or undefined for the level cap. Never throws.
 */
export function checkPackRules(
  total: number,
  starts: readonly number[],
  values: readonly number[],
  settings: RuleSettings,
  personCapPct: readonly (number | undefined)[] = [],
): RuleCheck {
  const capOk = Number.isFinite(settings.capPct) && settings.capPct >= 0;
  const valid = whole(total) && starts.length === values.length && starts.every(whole) && values.every(whole) && capOk;
  const t = whole(total) ? total : 0;
  const cap = capOk ? capFor(t, settings.capPct) : 0;
  const personCaps = values.map((_, i) => {
    const p = personCapPct[i];
    return p !== undefined && Number.isFinite(p) && p >= 0 ? capFor(t, p) : cap;
  });
  let sum = 0;
  let moved = 0;
  const overCap: number[] = [];
  values.forEach((raw, i) => {
    const v = Number.isFinite(raw) ? raw : 0;
    const s = Number.isFinite(starts[i]) ? starts[i]! : 0;
    sum += v;
    if (v > s) moved += v - s;
    if (Math.abs(v - s) > personCaps[i]!) overCap.push(i);
  });
  const diff = sum - t;
  const status: RuleStatus = !valid
    ? 'invalid'
    : diff > 0
      ? 'over'
      : diff < 0
        ? 'short'
        : settings.rule2 && overCap.length > 0
          ? 'person_over_cap'
          : settings.rule3 && moved > cap
            ? 'moved_too_much'
            : 'ok';
  return { ok: status === 'ok', status, total: t, sum, diff, moved, cap, personCaps, overCap };
}

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
