/**
 * Pack master rules (handover section 8). Pure module.
 *
 * - Category: from the pack master when it has one, else by name.
 * - CD subtotals (GM Adjustment / Target by department) and the distribution
 *   "By total" summary groups are derived from the pack name.
 *
 * Pack names look like CSD_CANS150, CSD_PET1000, AquafinA_500, STING_250,
 * LIT_PET500. Rules read the name in upper case, split on '_' / spaces.
 */

export type Category = 'CSD' | 'Water' | 'LRB-Others';
export const CATEGORIES: readonly Category[] = ['CSD', 'Water', 'LRB-Others'];

/** Pack names are matched ignoring underscores, spaces and case (CSD_CANS150 = CSD CANS150). */
export function packKey(name: string): string {
  return name.replace(/[\s_]+/g, '').toUpperCase();
}

function tokens(name: string): string[] {
  return name.toUpperCase().split(/[\s_\-]+/).filter(Boolean);
}

const STING_CSD = new Set(['STING250', 'STING240']);

/** Default category by name: Water = starts with AquafinA; CSD = CSD_*, PMIX, STING_250, STING_240; else LRB-Others. */
export function categoryByName(name: string): Category {
  const k = packKey(name);
  if (k.startsWith('AQUAFINA')) return 'Water';
  if (k.startsWith('CSD') || k === 'PMIX' || k.startsWith('PMIX') || STING_CSD.has(k)) return 'CSD';
  return 'LRB-Others';
}

/** Category from the pack master (keyed by packKey) when present, else by name. */
export function categoryOf(name: string, master?: ReadonlyMap<string, Category>): Category {
  return master?.get(packKey(name)) ?? categoryByName(name);
}

function petSize(name: string): number | null {
  for (const t of tokens(name)) {
    const r = /^(?:MS)?PET(\d{3,4})$/.exec(t);
    if (r) return Number(r[1]);
  }
  return null;
}

function hasTokenPrefix(name: string, prefixes: readonly string[]): boolean {
  return tokens(name).some((t) => prefixes.some((p) => t.startsWith(p)));
}

export function isCans(name: string): boolean {
  const k = packKey(name);
  return (categoryByName(name) === 'CSD' && hasTokenPrefix(name, ['CANS', 'CAN'])) || k === 'STING240';
}

/** CANS + single-serve: NRB, RB, SSPET, STING (CSD only). */
export function isSsnr(name: string, cat: Category = categoryByName(name)): boolean {
  if (cat !== 'CSD') return false;
  if (isCans(name)) return true;
  if (hasTokenPrefix(name, ['NRB', 'RB', 'SSPET', 'STING'])) return true;
  return false;
}

export function isMspet2(name: string, cat: Category = categoryByName(name)): boolean {
  const s = petSize(name);
  return cat === 'CSD' && s !== null && s >= 2000 && s <= 2250;
}

/** MPT / MSPET: PET 1000 and PET 2000-2250 (CSD only). */
export function isMspet(name: string, cat: Category = categoryByName(name)): boolean {
  const s = petSize(name);
  return cat === 'CSD' && s !== null && (s === 1000 || (s >= 2000 && s <= 2250));
}

export function isPmix(name: string): boolean {
  return packKey(name).includes('PMIX');
}

export function isLit(name: string): boolean {
  return tokens(name)[0] === 'LIT' || packKey(name).startsWith('LIPTON');
}

/** CD workbook subtotal lines a pack counts in (GM Adjustment, Target by department). */
export type CdSubtotal = 'CANS' | 'SSNR' | 'MSPET2' | 'MSPET' | 'CSD' | 'Water' | 'LRB-Others' | 'LRB';

export function cdSubtotals(name: string, master?: ReadonlyMap<string, Category>): CdSubtotal[] {
  const cat = categoryOf(name, master);
  const out: CdSubtotal[] = [];
  if (cat === 'CSD') {
    if (isCans(name)) out.push('CANS');
    if (isSsnr(name, cat)) out.push('SSNR');
    if (isMspet2(name, cat)) out.push('MSPET2');
    if (isMspet(name, cat)) out.push('MSPET');
  }
  out.push(cat, 'LRB');
  return out;
}

/** Brand family used to sub-group LRB-Others (LIT, Sting Energy, Tropicana...): the first name token. */
export function brandFamily(name: string): string {
  return tokens(name)[0] ?? name;
}

/** Rows of the distribution "By total" view (handover section 7). */
export type SummaryGroup = 'SSNR' | 'MPT' | 'PMIX' | 'Total CSD' | 'Water' | 'LIT' | 'Other LRB' | 'Total LRB-Others' | 'Total';
export const SUMMARY_GROUPS: readonly SummaryGroup[] = ['SSNR', 'MPT', 'PMIX', 'Total CSD', 'Water', 'LIT', 'Other LRB', 'Total LRB-Others', 'Total'];
/** The groups a person can type a new total for (the others are sums). */
export const EDITABLE_SUMMARY_GROUPS: readonly SummaryGroup[] = ['SSNR', 'MPT', 'PMIX', 'Water', 'LIT', 'Other LRB'];

/**
 * Every summary row a pack counts in. A CSD pack that is none of SSNR / MPT /
 * PMIX counts only in Total CSD and Total.
 */
export function summaryGroups(name: string, master?: ReadonlyMap<string, Category>): SummaryGroup[] {
  const cat = categoryOf(name, master);
  const out: SummaryGroup[] = [];
  if (cat === 'CSD') {
    if (isPmix(name)) out.push('PMIX');
    else if (isSsnr(name, cat)) out.push('SSNR');
    else if (isMspet(name, cat)) out.push('MPT');
    out.push('Total CSD');
  } else if (cat === 'Water') {
    out.push('Water');
  } else {
    out.push(isLit(name) ? 'LIT' : 'Other LRB', 'Total LRB-Others');
  }
  out.push('Total');
  return out;
}

/** The one editable summary group of a pack, or null (a CSD pack outside SSNR / MPT / PMIX). */
export function editableGroupOf(name: string, master?: ReadonlyMap<string, Category>): SummaryGroup | null {
  return summaryGroups(name, master).find((g) => EDITABLE_SUMMARY_GROUPS.includes(g)) ?? null;
}
