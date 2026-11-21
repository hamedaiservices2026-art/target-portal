/**
 * Average sales (handover section 6). Pure module.
 *
 * Like Excel AVERAGE: months with no value are skipped, not counted as zero.
 * A month that has a value of 0 does count.
 */
import type { Month } from './periods';

/** Cases by month for one route (or person) and pack. Missing month = no value. */
export type MonthSeries = Readonly<Record<Month, number | null | undefined>>;

export interface AverageResult {
  avg: number;
  /** Months that had a value. 0 means there was nothing to average (avg = 0). */
  count: number;
}

export function averageSales(series: MonthSeries | undefined, months: readonly Month[]): AverageResult {
  if (!series) return { avg: 0, count: 0 };
  let sum = 0;
  let count = 0;
  for (const m of new Set(months)) {
    const v = series[m];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    sum += v;
    count += 1;
  }
  return { avg: count > 0 ? sum / count : 0, count };
}

/** Sum of several series month by month (e.g. all routes of a supervisor). Missing stays missing. */
export function sumSeries(list: readonly (MonthSeries | undefined)[]): Record<Month, number> {
  const out: Record<Month, number> = {};
  for (const s of list) {
    if (!s) continue;
    for (const [m, v] of Object.entries(s)) {
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      out[m] = (out[m] ?? 0) + v;
    }
  }
  return out;
}

/** The value of one month, 0 when missing (PAGO / YAGO sales). */
export function monthValue(series: MonthSeries | undefined, m: Month): number {
  const v = series?.[m];
  return v === null || v === undefined || !Number.isFinite(v) ? 0 : v;
}
