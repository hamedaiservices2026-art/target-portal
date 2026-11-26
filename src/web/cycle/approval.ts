// The target approval workbook for signing (the "Template For Approval"
// layout): sheet 1, named after the month, has each pack's TARGET vs YAGO,
// PAGO and PLAN with the file's Total rows, the pack mix and the signature
// line; sheet 2, "By Manager", has the target by pack and channel with a
// total per Head and the grand total (ABC). Totals and % are Excel formulas.
import { brandFamily, cdSubtotals, type Category } from '../../shared/calc/packs';
import type { FileRow } from './parsers';
import type { Grid } from './compute';

type Cell = Record<string, unknown> | null;

export type ApprovalInput = {
  period: string;
  /** Packs and Total rows in the file's order. */
  layout: FileRow[];
  /** Pack -> category, for packs missing from the layout. */
  catOf: (p: string) => string;
  target: Grid; yago: Grid; pago: Grid; plan: Grid;
  /** Heads with their channels (in order) and the target per channel and pack. */
  heads: { name: string; chans: { label: string; g: Grid }[] }[];
  /** Pack -> the Total it shows under when the file does not list it (Admin › Packs). */
  under?: Record<string, string>;
  /** The company name and logo at the top of the first sheet (set by the admin). */
  brand?: { company: string; logo: { data: ArrayBuffer | Uint8Array; type: 'image/png' | 'image/jpeg'; width: number; height: number } | null };
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const BLUE = '#0000FF';
type RowStyle = { bg?: string; fg?: string; bold?: boolean; strong?: boolean };
/** Row fills and fonts of the approval template (by row name). */
const STYLES: Record<string, RowStyle> = {
  'total cans': { bg: '#D9E1F2', bold: true }, 'total ssnr': { bg: '#D9E1F2', bold: true }, 'total mspet': { bg: '#D9E1F2', bold: true },
  'total mspet 2.0/2.2/2.25': { bg: '#D0CECE' }, 'total big mspet': { bg: '#D0CECE' },
  'total csd': { bg: '#00B050', bold: true, strong: true }, 'total water': { bg: '#00B0F0', bold: true, strong: true },
  'total lit': { bg: '#FFFF00', bold: true, strong: true }, gatorade: { bg: '#FBE5D6' }, 'total gatorade': { bg: '#FBE5D6' },
  mplus_nrb300: { bg: '#E2EFDA' }, 'total rockstar': { bg: '#000000', fg: '#FFC000', bold: true, strong: true },
  'total sting energy': { bg: '#C00000', fg: '#FFFFFF', bold: true }, 'total energy': { bg: '#000000', fg: '#FFFFFF', bold: true },
  'total britvic': { bg: '#BDD7EE', bold: true, strong: true }, 'total lrb-others': { bg: '#FFC000', bold: true },
  'total lrb': { bg: BLUE, fg: '#FFFFFF', bold: true, strong: true },
};
const styleOf = (label: string): RowStyle => STYLES[label.trim().toLowerCase().replace(/\s+/g, ' ')] ?? {};
const isLrb = (label: string) => /^total\s+lrb\s*$/i.test(label.trim());

/** Excel column letters (0 = A). */
export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** "C7:C9,C12" for the rows given (sorted, runs joined). */
export function refList(col: string, rows: number[]): string {
  const r = [...new Set(rows)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < r.length; i++) {
    let j = i;
    while (j + 1 < r.length && r[j + 1] === r[j]! + 1) j++;
    out.push(i === j ? `${col}${r[i]}` : `${col}${r[i]}:${col}${r[j]}`);
    i = j;
  }
  return out.join(',');
}

type Line = { label: string; pack: string | null; of: string[] };

/**
 * The rows of the workbook: the layout, with packs of the target that are not
 * in it added before their category's Total (and counted in it and in Total LRB).
 */
export function approvalLines(layout: FileRow[], packs: string[], catOf: (p: string) => string, under: Record<string, string> = {}): Line[] {
  let lines: Line[] = layout.map((r) => ('p' in r ? { label: r.p, pack: r.p, of: [r.p] } : { label: r.t, pack: null, of: [...r.of] }));
  if (!lines.length) {
    // No file layout: packs by category, a Total per category, then Total LRB.
    const cats = [...new Set(packs.map(catOf))];
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

const n = (v: number | undefined) => (v ? v : null);

/** The % columns (E, G, I): green above 0, dark red below, as in the template. */
function pctRules(from: number, to: number) {
  return [5, 7, 9].flatMap((column) => [
    { cellRange: { from: { row: from, column }, to: { row: to, column } }, condition: { operator: '>', value: 0 }, style: { textColor: '#00B050' } },
    { cellRange: { from: { row: from, column }, to: { row: to, column } }, condition: { operator: '<', value: 0 }, style: { textColor: '#9C0006' } },
  ]);
}

export async function downloadApproval(inp: ApprovalInput, file: string): Promise<void> {
  const { default: write } = await import('write-excel-file/browser');
  await (write as unknown as (d: unknown, o: unknown) => { toFile: (f: string) => Promise<void> })(approvalSheets(inp), { features: [PRINT_FEATURE] }).toFile(file);
}

/** The worksheet's child elements in the order the file format requires. */
const SHEET_ORDER = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios',
  'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks',
  'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags',
  'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];

/** Split the worksheet's top-level child elements (sheetData can be large: plain scanning). */
function topChildren(inner: string): string[] {
  const out: string[] = [];
  const re = /<(\/?)([A-Za-z][\w:]*)[^>]*?(\/?)>/g;
  let depth = 0;
  let start = -1;
  for (let m = re.exec(inner); m; m = re.exec(inner)) {
    const [tag, close, , self] = m;
    if (depth === 0 && !close) start = m.index;
    if (close) depth--; else if (!self) depth++;
    if (depth === 0 && start >= 0) { out.push(inner.slice(start, m.index + tag.length)); start = -1; }
  }
  return out;
}

/**
 * Add elements to a worksheet and put every top-level element in the order the
 * file format requires (Excel blanks a sheet whose elements are out of order).
 * An added element replaces one of the same name.
 */
export function orderSheetXml(xml: string, add: string[]): string {
  const open = xml.match(/<worksheet\b[^>]*>/);
  const end = xml.lastIndexOf('</worksheet>');
  if (!open || end < 0) return xml;
  const head = xml.slice(0, open.index! + open[0].length);
  const name = (el: string) => /^<([\w:]+)/.exec(el)?.[1] ?? '';
  const added = new Set(add.map(name));
  const kids = topChildren(xml.slice(head.length, end)).filter((k) => !added.has(name(k))).concat(add);
  const rank = (el: string) => { const i = SHEET_ORDER.indexOf(name(el)); return i < 0 ? SHEET_ORDER.length : i; };
  const sorted = kids.map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i).map((x) => x.k);
  return head + sorted.join('') + xml.slice(end);
}

/** Print setup as in the template: one page (fit to page), A4, centred, the template's margins. */
export const PRINT_FEATURE = {
  files: {
    transform: {
      // Totals and % are formulas without stored results: Excel works them out on opening.
      'xl/workbook.xml': {
        transform(xml: string) {
          return xml.replace(/<calcPr\b[^>]*\/>/, '<calcPr calcId="191029" fullCalcOnLoad="1"/>');
        },
      },
      'xl/worksheets/sheet{id}.xml': {
        transform(xml: string, options: { print?: { orientation: 'portrait' | 'landscape' } }) {
          if (!options.print) return xml;
          const add = [
            '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>',
            '<printOptions horizontalCentered="1"/>',
            '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>',
            `<pageSetup paperSize="9" orientation="${options.print.orientation}" fitToWidth="1" fitToHeight="1"/>`,
          ];
          return orderSheetXml(xml, add);
        },
      },
    },
  },
};

/** The logo where the template has it: column C, rows 1 to 4, about 64 pixels high. */
function logoImages(inp: ApprovalInput): { images?: unknown[] } {
  const l = inp.brand?.logo;
  if (!l || !l.width || !l.height) return {};
  const h = 64;
  const w = Math.round((l.width / l.height) * h);
  return { images: [{ content: l.data, contentType: l.type, width: w, height: h, dpi: 96, anchor: { row: 1, column: 3 }, offsetX: Math.max(0, 115 - w), offsetY: 15, title: 'Logo' }] };
}

/** The two sheets for write-excel-file. */
export function approvalSheets(inp: ApprovalInput): unknown[] {
  const packs = Object.keys(inp.target).filter((p) => (inp.target[p] ?? 0) !== 0 || inp.layout.some((r) => 'p' in r && r.p === p));
  // The AOP file calls the CSD total "Total ABC"; the template calls it "Total CSD".
  const lines = approvalLines(inp.layout, packs, inp.catOf, inp.under).map((l) => (!l.pack && /^total\s+abc$/i.test(l.label.trim()) ? { ...l, label: 'Total CSD' } : l));
  const month = MONTHS[Number(inp.period.slice(5)) - 1] ?? inp.period;

  // ----- sheet 1: target vs YAGO, PAGO and PLAN -----
  const top = 7; // the first pack row (row 6 is the header)
  const rowOf = new Map<string, number>();
  lines.forEach((l, i) => { if (l.pack) rowOf.set(l.pack, top + i); });
  const base = { fontFamily: 'Calibri', fontSize: 11, alignVertical: 'center' };
  const border = (c: number, last: number, st: RowStyle, isHead = false) => ({
    leftBorderStyle: c === 1 ? 'medium' : 'hair', rightBorderStyle: c === last ? 'medium' : 'hair',
    topBorderStyle: isHead || st.strong ? 'medium' : 'hair', bottomBorderStyle: st.strong ? 'medium' : 'hair',
  });
  const head = (value: string, c: number, last: number) => ({
    ...base, value, fontWeight: 'bold', textColor: '#FFFFFF', backgroundColor: BLUE, align: c === 1 ? 'left' : 'center', wrap: c !== 1, ...border(c, last, {}, true),
  });
  // Title as in the template: the company name (blue) and "<Month> <year> Target", right of the logo.
  const title = (value: string, color: string) => ({ ...base, value, fontSize: 20, fontWeight: 'bold', textColor: color, align: 'center', columnSpan: 4, rowSpan: 2 });
  const company = inp.brand?.company ?? '';
  const s1: Cell[][] = [
    company ? [null, null, null, title(company, '#0070C0'), null, null, null] : [], [],
    [null, null, null, title(`${month} ${inp.period.slice(0, 4)} Target`, '#000000'), null, null, null], [],
    [{ ...base, value: '' }], [null,
    ...['Pack', 'TARGET', 'YAGO ', 'TARGET vs YAGO', 'PAGO ', 'TARGET vs PAGO', 'PLAN', 'TARGET vs PLAN'].map((h, i) => head(h, i + 1, 8))]];
  const sum = (col: string, l: Line) => `SUM(${refList(col, l.of.map((p) => rowOf.get(p)!).filter(Boolean))})`;
  lines.forEach((l, i) => {
    const r = top + i;
    const st = l.pack ? styleOf(l.label) : styleOf(l.label);
    const look = { ...base, ...(st.bg ? { backgroundColor: st.bg } : {}), ...(st.fg ? { textColor: st.fg } : {}), ...(st.bold ? { fontWeight: 'bold' } : {}) };
    const num = (c: number, col: string, src: Grid) => ({
      ...look, ...border(c, 8, st), align: 'right', format: '#,##0',
      ...(l.pack ? { type: Number, value: n(src[l.pack]) } : { type: 'Formula', value: sum(col, l) }),
    });
    const pct = (c: number, a: string, b: string) => ({ ...look, ...border(c, 8, st), align: 'right', format: '0.0%', type: 'Formula', value: `IFERROR(${a}${r}/${b}${r}-1,0)` });
    s1.push([null, { ...look, ...border(1, 8, st), align: 'left', value: l.label },
      num(2, 'C', inp.target), num(3, 'D', inp.yago), pct(4, 'C', 'D'), num(5, 'F', inp.pago), pct(6, 'C', 'F'), num(7, 'H', inp.plan), pct(8, 'C', 'H')]);
  });
  // Pack mix: shares of the CSD total.
  const rowByLabel = (re: RegExp) => { const i = lines.findIndex((l) => re.test(l.label.trim())); return i < 0 ? null : top + i; };
  const csd = rowByLabel(/^total\s+csd$/i);
  const mix = ([['CANs', rowByLabel(/^total\s+cans$/i)], ['NRB', rowByLabel(/^csd_nrb/i)], ['SSNR', rowByLabel(/^total\s+ssnr$/i)], ['MSPET', rowByLabel(/^total\s+mspet$/i)]] as [string, number | null][])
    .filter(([, r]) => r !== null) as [string, number][];
  s1.push([]);
  if (csd && mix.length) {
    s1.push([null, null, { ...base, value: 'PACK MIX', fontWeight: 'bold', backgroundColor: '#00B0F0', align: 'center', borderStyle: 'medium', columnSpan: 4 }, null, null, null]);
    s1.push([null, ...['SOM', 'Target', 'YAGO', 'PAGO', 'PLAN'].map((h, i) => head(h, i + 1, 5))]);
    mix.forEach(([label, r], k) => {
      const st: RowStyle = {};
      const b = (c: number) => ({ ...border(c, 5, st), bottomBorderStyle: k === mix.length - 1 ? 'medium' : 'hair' });
      s1.push([null, { ...base, ...b(1), align: 'left', value: label },
        ...(['C', 'D', 'F', 'H'] as const).map((col, i) => ({ ...base, ...b(i + 2), align: 'right', format: '0.0%', type: 'Formula', value: `IFERROR(${col}${r}/${col}${csd},0)` }))]);
    });
    for (let k = 0; k < 11; k++) s1.push([]);
  } else {
    for (let k = 0; k < 2; k++) s1.push([]);
  }
  s1.push([null, { ...base, fontWeight: 'bold', value: ' BM _________________________ CD _________________________ FD ________________________ GM _________________________' }]);

  // ----- sheet 2: by Head and channel -----
  type Col = { label: string; g?: Grid; sumOf?: number[]; total?: boolean };
  const cols: Col[] = [];
  const grand: number[] = [];
  for (const h of inp.heads) {
    const first = cols.length;
    for (const c of h.chans) cols.push({ label: c.label, g: c.g });
    if (h.chans.length > 1) {
      cols.push({ label: `Total ${h.name}`, sumOf: Array.from({ length: h.chans.length }, (_, k) => first + k), total: true });
      grand.push(cols.length - 1);
    } else if (h.chans.length === 1) grand.push(first);
  }
  cols.push({ label: 'ABC', sumOf: grand, total: true });
  const last = cols.length + 1; // column index of ABC (B = 1)
  const base2 = { ...base, fontSize: 10 };
  const head2 = (value: string, c: number) => ({ ...head(value, c, last), fontSize: 10 });
  const top2 = 5;
  const row2 = new Map<string, number>();
  lines.forEach((l, i) => { if (l.pack) row2.set(l.pack, top2 + i); });
  const s2: Cell[][] = [[], [], [null, { ...base2, fontSize: 11, value: new Date(Date.UTC(Number(inp.period.slice(0, 4)), Number(inp.period.slice(5)) - 1, 1)), type: Date, format: 'mmm-yy', fontWeight: 'bold', backgroundColor: '#FFFF00', align: 'center', borderStyle: 'medium', columnSpan: last }],
    [null, head2('Pack', 1), ...cols.map((c, i) => head2(c.label, i + 2))]];
  lines.forEach((l, i) => {
    const r = top2 + i;
    const st = styleOf(l.label);
    const look = { ...base2, ...(st.bg ? { backgroundColor: st.bg } : {}), ...(st.fg ? { textColor: st.fg } : {}), ...(st.bold ? { fontWeight: 'bold' } : {}) };
    s2.push([null, { ...look, ...border(1, last, st), align: 'left', value: l.label },
      ...cols.map((c, k) => {
        const col = colName(k + 2);
        const cell = { ...look, ...border(k + 2, last, st), align: 'right', format: '#,##0' };
        if (c.sumOf) return { ...cell, type: 'Formula', value: `SUM(${c.sumOf.map((j) => `${colName(j + 2)}${r}`).join(',')})` };
        if (!l.pack) return { ...cell, type: 'Formula', value: `SUM(${refList(col, l.of.map((p) => row2.get(p)!).filter(Boolean))})` };
        return { ...cell, type: Number, value: n(c.g?.[l.pack]) };
      })]);
  });

  return [
    { sheet: month, data: s1, print: { orientation: 'portrait' }, ...logoImages(inp), conditionalFormatting: pctRules(top, top + lines.length - 1), showGridLines: false, stickyRowsCount: 6, stickyColumnsCount: 2, columns: [{ width: 9 }, { width: 27.5 }, ...Array.from({ length: 7 }, () => ({ width: 15.7 }))] },
    { sheet: 'By Manager', data: s2, print: { orientation: 'landscape' }, showGridLines: false, stickyRowsCount: 4, stickyColumnsCount: 2, columns: [{ width: 1.5 }, { width: 22.5 }, ...cols.map((c) => ({ width: c.total ? 11.5 : 10.3 }))] },
  ];
}
