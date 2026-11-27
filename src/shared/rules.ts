/**
 * Redistribution rules (the 5% cap) and case-input parsing. Pure module:
 * shared by the browser and the Worker.
 *
 * A pack passes when
 *   sum(values) = total
 *   every |value_i - start_i| <= cap
 *   sum(max(0, value_i - start_i)) <= cap
 * where cap = floor(capPct * total / 100).
 */
import type { Grid, PackCode } from './types';

/** Cap in whole cases: floor(capPct * total / 100), guarded against float error. */
export function capFor(total: number, capPct: number): number {
  return Math.floor((capPct * 100 * total + 1e-6) / 10000);
}

/**
 * `invalid`: an input is not usable (total, a start or a value is not a finite
 * whole number >= 0, capPct is not a finite number >= 0, or starts/values differ
 * in length). It takes precedence over over/short and is never ok.
 */
export type PackStatus = 'ok' | 'over' | 'short' | 'person_over_cap' | 'moved_too_much' | 'invalid';

/**
 * Handover rules: rule 2 (one person's change <= their cap) and rule 3 (total
 * moved <= the level cap) can each be switched off; a named person may have
 * their own cap % (`personCapPct[i]`, undefined = the level cap).
 */
export interface RuleOptions {
  rule2?: boolean;
  rule3?: boolean;
  personCapPct?: readonly (number | undefined)[];
  /**
   * Rule 2 base: 'group' (default) = the threshold % of the pack total being
   * split; 'own' = the threshold % of each person's own starting value.
   */
  personBase?: 'group' | 'own';
}

export interface PackCheck {
  ok: boolean;
  status: PackStatus;
  total: number;
  sum: number;
  /** sum - total: positive when over, negative when short. */
  diff: number;
  /** sum of the increases over the starting values. Reported even when sum != total. */
  moved: number;
  cap: number;
  /** Per person: the most their value may move under rule 2. */
  caps: number[];
}

function isWholeCases(n: number): boolean {
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}

/** Numbers reported to the UI are always finite: anything not computable shows as 0. */
function finiteOrZero(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) ? n : 0;
}

/**
 * Never throws (the UI calls it while users type); unusable input yields
 * status 'invalid' with ok:false and finite numeric fields.
 */
export function checkPack(total: number, starts: number[], values: number[], capPct: number, opts: RuleOptions = {}): PackCheck {
  const valid =
    starts.length === values.length &&
    isWholeCases(total) &&
    starts.every(isWholeCases) &&
    values.every(isWholeCases) &&
    Number.isFinite(capPct) &&
    capPct >= 0;

  const safeTotal = finiteOrZero(total);
  const cap = valid ? capFor(total, capPct) : finiteOrZero(Number.isFinite(capPct) && capPct >= 0 ? capFor(safeTotal, capPct) : 0);
  const rule2 = opts.rule2 ?? true;
  const rule3 = opts.rule3 ?? true;
  let sum = 0;
  let moved = 0;
  let personOver = false;
  const caps: number[] = [];
  const own = opts.personBase === 'own';
  for (let i = 0; i < values.length; i++) {
    const v = finiteOrZero(values[i]);
    const delta = v - finiteOrZero(starts[i]);
    sum += v;
    if (delta > 0) moved += delta;
    const pp = opts.personCapPct?.[i];
    const pct = pp !== undefined && Number.isFinite(pp) && pp >= 0 ? pp : Number.isFinite(capPct) && capPct >= 0 ? capPct : 0;
    const personCap = own ? capFor(finiteOrZero(starts[i]), pct) : pp !== undefined && Number.isFinite(pp) && pp >= 0 ? capFor(safeTotal, pp) : cap;
    caps.push(personCap);
    if (Math.abs(delta) > personCap) personOver = true;
  }
  const diff = sum - safeTotal;
  const status: PackStatus = !valid
    ? 'invalid'
    : diff > 0
      ? 'over'
      : diff < 0
        ? 'short'
        : rule3 && moved > cap
          ? 'moved_too_much'
          : rule2 && personOver
            ? 'person_over_cap'
            : 'ok';
  return { ok: status === 'ok', status, total: safeTotal, sum, diff, moved, cap, caps };
}

export function checkAll(
  totals: Grid,
  starts: Grid[],
  values: Grid[],
  packs: PackCode[],
  capPct: number,
  opts: RuleOptions = {},
): { ok: boolean; byPack: Record<PackCode, PackCheck> } {
  const byPack: Record<PackCode, PackCheck> = {};
  let ok = true;
  for (const pack of packs) {
    const check = checkPack(
      totals[pack] ?? 0,
      starts.map((g) => g[pack] ?? 0),
      values.map((g) => g[pack] ?? 0),
      capPct,
      opts,
    );
    byPack[pack] = check;
    if (!check.ok) ok = false;
  }
  return { ok, byPack };
}

const ARABIC_INDIC_ZERO = 0x0660; // ٠-٩
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0; // ۰-۹

function toWesternDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= EXTENDED_ARABIC_INDIC_ZERO ? code - EXTENDED_ARABIC_INDIC_ZERO : code - ARABIC_INDIC_ZERO);
  });
}

/**
 * Parses a whole-case count typed or pasted by a user. Accepts Western,
 * Arabic-Indic and Persian digits, optional `,` thousands separators (groups
 * of three) and surrounding whitespace. Anything else (empty, decimals,
 * negatives, text) returns null.
 */
export function parseCaseInput(raw: string): number | null {
  // Bidi marks (LRM, RLM, ALM) often ride along with Arabic text; strip them, then trim whitespace.
  const s = toWesternDigits(raw.replace(/[‎‏؜]/g, '').trim());
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}
