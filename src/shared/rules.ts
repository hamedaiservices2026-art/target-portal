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

export type PackStatus = 'ok' | 'over' | 'short' | 'moved_too_much';

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
}

export function checkPack(total: number, starts: number[], values: number[], capPct: number): PackCheck {
  if (starts.length !== values.length) {
    throw new RangeError(`checkPack: starts (${starts.length}) and values (${values.length}) differ in length`);
  }
  const cap = capFor(total, capPct);
  let sum = 0;
  let moved = 0;
  let maxChange = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const delta = v - starts[i]!;
    sum += v;
    if (delta > 0) moved += delta;
    const abs = Math.abs(delta);
    if (abs > maxChange) maxChange = abs;
  }
  const diff = sum - total;
  const status: PackStatus =
    diff > 0 ? 'over' : diff < 0 ? 'short' : moved > cap || maxChange > cap ? 'moved_too_much' : 'ok';
  return { ok: status === 'ok', status, total, sum, diff, moved, cap };
}

export function checkAll(
  totals: Grid,
  starts: Grid[],
  values: Grid[],
  packs: PackCode[],
  capPct: number,
): { ok: boolean; byPack: Record<PackCode, PackCheck> } {
  const byPack: Record<PackCode, PackCheck> = {};
  let ok = true;
  for (const pack of packs) {
    const check = checkPack(
      totals[pack] ?? 0,
      starts.map((g) => g[pack] ?? 0),
      values.map((g) => g[pack] ?? 0),
      capPct,
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
