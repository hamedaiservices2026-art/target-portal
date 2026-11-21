/**
 * Month helpers for the target cycle (handover section 1). Pure module.
 *
 * A month is 'YYYY-MM'. PAGO = the month before the target month, YAGO = the
 * same month a year earlier, and the default average window is the 3 months
 * before the target month.
 */

export type Month = string; // 'YYYY-MM'

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonth(s: string): boolean {
  return MONTH_RE.test(s);
}

function parts(m: Month): [number, number] {
  const r = MONTH_RE.exec(m);
  if (!r) throw new RangeError(`not a month (YYYY-MM): ${m}`);
  return [Number(r[1]), Number(r[2])];
}

function fmt(y: number, mo: number): Month {
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}`;
}

/** Month `n` months after `m` (n may be negative). */
export function addMonths(m: Month, n: number): Month {
  const [y, mo] = parts(m);
  const idx = y * 12 + (mo - 1) + n;
  return fmt(Math.floor(idx / 12), (idx % 12) + 1);
}

export function pago(target: Month): Month {
  return addMonths(target, -1);
}

export function yago(target: Month): Month {
  return addMonths(target, -12);
}

/** The `count` months before the target month, oldest first (default 3: Jul-Sep for Oct). */
export function defaultAvgMonths(target: Month, count = 3): Month[] {
  const out: Month[] = [];
  for (let i = count; i >= 1; i--) out.push(addMonths(target, -i));
  return out;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Excel serial date (1900 system) -> month. */
function fromExcelSerial(n: number): Month | null {
  if (!Number.isFinite(n) || n < 1 || n > 2958465) return null;
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

function expandYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

/**
 * Parses a month column header or period cell in any layout the sales file
 * uses (handover section 4, step 5): 2026-09, 202609, an Excel date (serial
 * number or Date), Sep-26, Sep 2026, September 2026, 09/2026. Returns null
 * when the value is not a month.
 */
export function parseMonth(v: unknown): Month | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return fmt(v.getUTCFullYear(), v.getUTCMonth() + 1);
  }
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 190001 && v <= 299912) {
      const y = Math.floor(v / 100);
      const mo = v % 100;
      return mo >= 1 && mo <= 12 ? fmt(y, mo) : null;
    }
    return fromExcelSerial(v);
  }
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  let r: RegExpExecArray | null;
  // 2026-09, 2026/09, 2026-09-01 (date text)
  if ((r = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?(?:[ t].*)?$/.exec(s))) {
    const mo = Number(r[2]);
    return mo >= 1 && mo <= 12 ? fmt(Number(r[1]), mo) : null;
  }
  // 202609
  if ((r = /^(\d{4})(\d{2})$/.exec(s))) {
    const mo = Number(r[2]);
    return mo >= 1 && mo <= 12 ? fmt(Number(r[1]), mo) : null;
  }
  // 09/2026, 9-2026
  if ((r = /^(\d{1,2})[-/.](\d{4})$/.exec(s))) {
    const mo = Number(r[1]);
    return mo >= 1 && mo <= 12 ? fmt(Number(r[2]), mo) : null;
  }
  // Sep-26, Sep 2026, September 2026, sept-2026
  if ((r = /^([a-z]+)[\s\-/.']*(\d{2}|\d{4})$/.exec(s))) {
    const name = r[1]!;
    const idx = MONTH_NAMES.findIndex((m) => name.startsWith(m));
    if (idx < 0) return null;
    const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'][idx]!;
    if (!(full.startsWith(name) || name === 'sept')) return null;
    return fmt(expandYear(Number(r[2])), idx + 1);
  }
  // A serial number typed as text
  if (/^\d{5}(\.\d+)?$/.test(s)) return fromExcelSerial(Number(s));
  return null;
}
