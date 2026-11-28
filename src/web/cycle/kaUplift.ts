// Key Accounts: how far each KAE sold above their previous target, and the uplift % it gives.
import { total, type Grid } from './compute';
import type { RouteMonthData } from './parsers';

/** Sum of sales and previous target per pack over the months that have a previous target for the KAE. */
export function achievement(route: string, months: string[], sales: RouteMonthData, prev: RouteMonthData): { s: Grid; t: Grid } {
  const s: Grid = {};
  const t: Grid = {};
  for (const m of months) {
    const tg = prev[m]?.[route];
    if (!tg) continue;
    for (const [p, n] of Object.entries(tg)) t[p] = (t[p] ?? 0) + n;
    for (const [p, n] of Object.entries(sales[m]?.[route] ?? {})) s[p] = (s[p] ?? 0) + n;
  }
  return { s, t };
}

/**
 * The uplift % of one KAE and pack: (sales / previous target - 1), kept
 * between min and max. By pack when the KAE had a target and sales for the
 * pack; else by the KAE's total; else the minimum.
 */
export function upliftPct(a: { s: Grid; t: Grid }, pack: string, min: number, max: number): number {
  const clamp = (x: number) => Math.min(max, Math.max(min, x));
  const tp = a.t[pack] ?? 0;
  const sp = a.s[pack] ?? 0;
  if (tp > 0 && sp > 0) return clamp((sp / tp - 1) * 100);
  const tt = total(a.t);
  if (tt > 0) return clamp((total(a.s) / tt - 1) * 100);
  return min;
}

