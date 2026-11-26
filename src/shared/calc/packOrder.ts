/**
 * One pack order for every table: the rows of the uploaded target file (its
 * packs and Total rows), and without a file the default layout below, which is
 * the order of the "Target by Pack by Department" file. Pure module.
 */
import { brandFamily, cdSubtotals, packKey, PACK_ALIASES, type Category } from './packs';

/** The rows of a target file in its own order: packs, and the file's Total rows with the packs each one sums. */
export type FileRow = { p: string } | { t: string; of: string[] };
export type PackLine = { label: string; pack: string | null; of: string[] };

const CANS = ['CSD_CANS150', 'STING_240', 'CSD_CANS185', 'CSD_CANS240', 'CSD_CANS300', 'CSD_CANS320', 'CSD_CANS325', 'CSD_CANS330', 'CSD_CANS355', 'CSD_CANS360'];
const SS = ['CSD_NRB', 'STING_250', 'STING_250_SSPET', 'CSD_SSPET250', 'CSD_SSPET400', 'CSD_SSPET500', 'CSD_SSPET500/400'];
const MSPET = ['CSD_PET1000', 'CSD_PET2000+', 'CSD_PET2000', 'CSD_PET2200', 'CSD_PET2250'];
const CSD = [...CANS, ...SS, ...MSPET, 'PMIX'];
const WATER = ['AquafinA_200', 'AquafinA_330', 'AquafinA_500', 'AquafinA_1500', 'AquafinA_Sparkling_250', 'AquafinA_NRB_250', 'AquafinA_NRB_330', 'AquafinA_NRB_750'];
const LIT = ['LIT_CANS150', 'LIT_CANS240', 'LIT_CANS310', 'LIT_CANS315', 'LIT_PET500', 'LIT_PET1.0L', 'LIT_TETRA200', 'LIT_FSY'];
const GATORADE = ['GATORADE', 'Propel'];
const ROCKSTAR = ['Rockstar_185', 'Rockstar_250'];
const STING = ['Sting Energy_185', 'Sting Energy_240', 'Sting Energy_300'];
const BRITVIC = ['Britvic_300', 'Britvic_Soda'];
const LRB_OTHERS = [...LIT, ...GATORADE, 'MPLUS_NRB300', ...ROCKSTAR, ...STING, ...BRITVIC];

const P = (list: string[]): FileRow[] => list.map((p) => ({ p }));
/** The default layout (the department file's order and Total rows). */
export const DEFAULT_LAYOUT: readonly FileRow[] = [
  ...P(CANS), { t: 'Total CANS', of: CANS },
  ...P(SS), { t: 'Total SSNR', of: [...CANS, ...SS] },
  ...P(MSPET), { t: 'Total MSPET', of: MSPET },
  { p: 'PMIX' }, { t: 'Total CSD', of: CSD },
  ...P(WATER), { t: 'Total Water', of: WATER },
  ...P(LIT), { t: 'Total LIT', of: LIT },
  ...P(GATORADE), { t: 'Total Gatorade', of: GATORADE },
  { p: 'MPLUS_NRB300' },
  ...P(ROCKSTAR), { t: 'Total ROCKSTAR', of: ROCKSTAR },
  ...P(STING), { t: 'Total Sting Energy', of: STING },
  { t: 'Total Energy', of: [...ROCKSTAR, ...STING] },
  ...P(BRITVIC), { t: 'Total Britvic', of: BRITVIC },
  { t: 'Total LRB-Others', of: LRB_OTHERS },
  { t: 'Total LRB', of: [...CSD, ...WATER, ...LRB_OTHERS] },
];

/** Pack names of a layout mapped to the pack codes given (spacing, case and merged packs ignored). */
export function mapLayout(layout: readonly FileRow[], codes: readonly string[]): FileRow[] {
  const idx = new Map(codes.map((c) => [packKey(c), c]));
  for (const [alias, to] of Object.entries(PACK_ALIASES)) {
    const t = idx.get(packKey(to));
    if (t) idx.set(packKey(alias), t);
  }
  const code = (n: string) => idx.get(packKey(n)) ?? n;
  const seen = new Set<string>();
  const out: FileRow[] = [];
  for (const r of layout) {
    if ('p' in r) {
      const c = code(r.p);
      if (!seen.has(c)) { seen.add(c); out.push({ p: c }); }
    } else out.push({ t: r.t, of: [...new Set(r.of.map(code))] });
  }
  return out;
}

/** The default layout for these packs: only their rows, and only Totals that count one of them. */
export function defaultLayout(packs: readonly string[]): FileRow[] {
  const have = new Set(packs);
  return mapLayout(DEFAULT_LAYOUT, packs)
    .filter((r) => ('p' in r ? have.has(r.p) : r.of.some((x) => have.has(x))))
    .map((r) => ('p' in r ? r : { t: r.t, of: r.of.filter((x) => have.has(x)) }));
}

const isLrb = (label: string) => /^total\s+lrb\s*$/i.test(label.trim());

/**
 * The rows of the workbook: the layout, with packs of the target that are not
 * in it added before their category's Total (and counted in it and in Total LRB).
 */
export function approvalLines(layout: FileRow[], packs: string[], catOf: (p: string) => string, under: Record<string, string> = {}): PackLine[] {
  let lines: PackLine[] = layout.map((r) => ('p' in r ? { label: r.p, pack: r.p, of: [r.p] } : { label: r.t, pack: null, of: [...r.of] }));
  // No file: the default layout (the department file's order and Total rows).
  if (!lines.length) lines = defaultLayout(packs).map((r) => ('p' in r ? { label: r.p, pack: r.p, of: [r.p] } : { label: r.t, pack: null, of: [...r.of] }));
  if (!lines.length) {
    // None of the packs is in the default layout: by category (CSD, Water, LRB-Others), a Total each, then Total LRB.
    const rank = (c: string) => { const i = ['csd', 'water', 'lrb-others'].indexOf(c.toLowerCase()); return i < 0 ? 9 : i; };
    const cats = [...new Set(packs.map(catOf))].sort((x, y) => rank(x) - rank(y));
    for (const c of cats) {
      const ps = packs.filter((p) => catOf(p) === c);
      lines.push(...ps.map((p) => ({ label: p, pack: p, of: [p] })), { label: `Total ${c}`, pack: null, of: ps });
    }
    lines.push({ label: 'Total LRB', pack: null, of: [...packs] });
    return lines;
  }
  const known = new Set(lines.filter((l) => l.pack).map((l) => l.pack!));
  // The pack's groups, most specific first: CANS / SSNR / MSPET 2.0+ / MSPET for CSD, the brand for LRB-Others.
  const groups = (p: string): string[] => {
    const c = catOf(p);
    if (c === 'CSD') return cdSubtotals(p, new Map([[p, 'CSD' as Category]])).filter((x) => x !== 'CSD' && x !== 'LRB').map((x) => `CSD:${x}`);
    return c === 'LRB-Others' ? [`LRB:${brandFamily(p).toLowerCase()}`] : [];
  };
  const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const p of packs.filter((x) => !known.has(x))) {
    // The Total the admin chose for this pack (Admin › Packs): last row above it, counted in it and in every Total around it.
    const want = under[p] ? norm(under[p]!) : '';
    const tAt = want ? lines.findIndex((l) => !l.pack && norm(l.label) === want) : -1;
    if (tAt >= 0) {
      const inner = new Set(lines[tAt]!.of);
      for (const l of lines) if (!l.pack && (l === lines[tAt] || (inner.size > 0 && [...inner].every((x) => l.of.includes(x))))) l.of.push(p);
      lines.splice(tAt, 0, { label: p, pack: p, of: [p] });
      known.add(p);
      continue;
    }
    // After the last pack of its group in the file, and counted in every Total that pack is in.
    let sib = -1;
    for (const g of groups(p)) {
      lines.forEach((l, i) => { if (l.pack && known.has(l.pack) && groups(l.pack).includes(g)) sib = i; });
      if (sib >= 0) break;
    }
    if (sib >= 0) {
      const q = lines[sib]!.pack!;
      for (const l of lines) if (!l.pack && l.of.includes(q) && !l.of.includes(p)) l.of.push(p);
      lines.splice(sib + 1, 0, { label: p, pack: p, of: [p] });
      known.add(p);
      continue;
    }
    const c = catOf(p).toLowerCase();
    const names = c === 'csd' ? ['total csd', 'total abc'] : [`total ${c}`];
    let at = lines.findIndex((l) => !l.pack && names.includes(l.label.trim().toLowerCase()));
    if (at < 0) at = lines.findIndex((l) => !l.pack && isLrb(l.label));
    if (at < 0) at = lines.length;
    if (lines[at]) lines[at]!.of.push(p);
    lines.splice(at, 0, { label: p, pack: p, of: [p] });
  }
  const lrb = lines.find((l) => !l.pack && isLrb(l.label));
  if (lrb) lrb.of = [...new Set([...lrb.of, ...packs])];
  else lines = [...lines, { label: 'Total LRB', pack: null, of: lines.filter((l) => l.pack).map((l) => l.pack!) }];
  return lines;
}

/** The packs given in the order of the layout (the default layout when there is none). */
export function orderPacks(packs: readonly string[], catOf: (p: string) => string, layout: readonly FileRow[] = [], under: Record<string, string> = {}): string[] {
  const set = new Set(packs);
  return approvalLines([...layout], [...set], catOf, under).flatMap((l) => (l.pack && set.has(l.pack) ? [l.pack] : []));
}
