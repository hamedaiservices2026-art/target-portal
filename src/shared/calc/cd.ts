/** Commercial Director submit check and final fit (handover section 5, step C). */
import { fitAndRound } from './fit';

export type PackCat = Map<string, string>;

/** The CD work saved with the cycle. */
export type CdWork = {
  /** New Target per pack (GM Adjustment). */
  nt: Record<string, number>;
  /** New Target approved (required before the split). */
  ntOk: boolean;
  /** Target by department: dept -> channel -> pack -> cases. */
  dm: Record<string, Record<string, Record<string, number>>>;
  /** The New Target the split was made from (stale when it differs). */
  splitNt: Record<string, number>;
  /** How each pack's default split was weighted. */
  basis: Record<string, string>;
  /** Column I overrides: dept -> category -> cases. */
  gm: Record<string, Record<string, number>>;
  /** Column J (final department total): dept -> category -> cases. */
  colJ: Record<string, Record<string, number>>;
};

/**
 * Submit check (section 5): New Target approved; split exists and is not
 * stale; every pack of Tab 2 adds up to its New Target; column J per category
 * = the category's New Target. Returns the reasons it fails (empty = ok).
 */
export function cdSubmitProblems(work: CdWork, cats: PackCat, depts: string[]): string[] {
  const out: string[] = [];
  if (!work.ntOk) out.push('the New Target is not approved');
  const packs = Object.keys(work.nt);
  const unknown = packs.filter((p) => !cats.has(p));
  if (unknown.length) out.push(`packs not in the pack master: ${unknown.slice(0, 10).join(', ')}`);
  if (Object.keys(work.dm).length === 0) out.push('there is no split by department');
  else if (packs.some((p) => (work.splitNt[p] ?? 0) !== work.nt[p]) || Object.keys(work.splitNt).some((p) => !(p in work.nt))) {
    out.push('the split is stale: the New Target changed after it was made');
  }
  let badPacks = 0;
  for (const p of packs) {
    let s = 0;
    for (const d of Object.keys(work.dm)) for (const ch of Object.values(work.dm[d]!)) s += ch[p] ?? 0;
    if (s !== work.nt[p]) badPacks++;
  }
  if (badPacks) out.push(`${badPacks} packs in Target by department don't add up`);
  for (const cat of new Set(packs.map((p) => cats.get(p)).filter((c): c is string => !!c))) {
    const want = packs.filter((p) => cats.get(p) === cat).reduce((s, p) => s + work.nt[p]!, 0);
    const got = depts.reduce((s, d) => s + (work.colJ[d]?.[cat] ?? 0), 0);
    if (want !== got) out.push(`column J of ${cat} adds up to ${got}, not the New Target ${want}`);
  }
  return out;
}

/**
 * The final department x pack target: per category, rows = New Target per
 * pack and columns = column J per department, fitted from Tab 2 by iterative
 * proportional fitting (80 iterations) and rounded to whole cases.
 */
export function cdFinal(work: CdWork, cats: PackCat, depts: string[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = Object.fromEntries(depts.map((d) => [d, {}]));
  const packs = Object.keys(work.nt);
  for (const cat of new Set(packs.map((p) => cats.get(p)!))) {
    const rows = packs.filter((p) => cats.get(p) === cat).sort();
    const seed = rows.map((p) => depts.map((d) => Object.values(work.dm[d] ?? {}).reduce((s, ch) => s + (ch[p] ?? 0), 0)));
    const fitted = fitAndRound(seed, rows.map((p) => work.nt[p]!), depts.map((d) => work.colJ[d]?.[cat] ?? 0));
    rows.forEach((p, i) => depts.forEach((d, j) => { out[d]![p] = fitted[i]![j]!; }));
  }
  return out;
}

