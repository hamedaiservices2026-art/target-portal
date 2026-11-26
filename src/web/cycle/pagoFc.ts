// PAGO forecast closing: pure helpers (see pages/cycle/PagoForecast.tsx).

export type PagoFc = { on: boolean; done: number; left: number };

/** Days of the month that are not Fridays, from day `from` to day `to`. */
export function workingDays(month: string, from = 1, to?: number): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5)) - 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  let n = 0;
  for (let d = from; d <= Math.min(to ?? last, last); d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() !== 5) n++;
  return n;
}

/** Working days with sales and left in the month, as of today (sales are in up to yesterday). */
export function defaultFc(month: string, today = new Date()): PagoFc {
  const all = workingDays(month);
  const ym = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  if (ym < month) return { on: true, done: 0, left: all };
  if (ym > month) return { on: false, done: all, left: 0 };
  const done = workingDays(month, 1, today.getDate() - 1);
  return { on: true, done, left: all - done };
}

/** Sales by day x remaining days, added to the actual: the factor that turns actual PAGO sales into the forecast closing. */
export function fcFactor(fc: PagoFc | null | undefined): number {
  if (!fc || !fc.on || fc.done <= 0 || fc.left <= 0) return 1;
  return 1 + fc.left / fc.done;
}

