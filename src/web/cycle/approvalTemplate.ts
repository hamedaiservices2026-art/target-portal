// The approval workbook from the admin's own template (Cycle setup): the
// template's file is kept as it is (logo, title box, colours, Total rows, Pack
// Mix, signature line, macros) and only the numbers are written: on the first
// sheet TARGET, YAGO, PAGO and PLAN of each pack row, on "By Manager" the
// target of each pack per channel. The month replaces the template's month
// (sheet name, title, the date cell). Formulas stay and Excel recalculates them
// on open. Pure module (no DOM): the caller saves the bytes.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Grid } from './compute';

export type TemplateInput = {
  period: string;
  target: Grid; yago: Grid; pago: Grid; plan: Grid;
  /** Channel column label -> target by pack (the "By Manager" sheet). */
  channels: { label: string; g: Grid }[];
  /** A row's pack name -> pack code (null: not a pack of the master). */
  codeOf: (name: string) => string | null;
};

export type TemplateResult = {
  data: Uint8Array;
  /** Packs with a target that the template has no row for. */
  missing: string[];
  /** Rows of the template whose name is not a known pack (their numbers are cleared). */
  unknown: string[];
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_RE = new RegExp(`\\b(${MONTHS.join('|')})(\\s+)(\\d{4})(\\s+Target)`, 'gi');

const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const squash = (s: string) => s.toLowerCase().replace(/[\s_\-./–]+/g, '');

/** Column letters -> 0-based index. */
function colIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

type Cell = { col: string; row: number; attrs: string; inner: string | null };

function parseCells(rowInner: string): Cell[] {
  const out: Cell[] = [];
  const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  for (let m = re.exec(rowInner); m; m = re.exec(rowInner)) {
    const ref = /\br="([A-Z]+)(\d+)"/.exec(m[1]!);
    if (!ref) continue;
    out.push({ col: ref[1]!, row: Number(ref[2]), attrs: m[1]!, inner: m[2] ?? null });
  }
  return out;
}

const writeCell = (c: Cell) => (c.inner === null || c.inner === '' ? `<c${c.attrs}/>` : `<c${c.attrs}>${c.inner}</c>`);

/** The text of a cell (shared string, inline string or value). */
function cellText(c: Cell | undefined, shared: string[]): string {
  if (!c || !c.inner) return '';
  const t = /\bt="(\w+)"/.exec(c.attrs)?.[1];
  if (t === 's') { const v = /<v>([^<]*)<\/v>/.exec(c.inner)?.[1]; return v === undefined ? '' : shared[Number(v)] ?? ''; }
  if (t === 'inlineStr') return unesc([...c.inner.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(''));
  const v = /<v>([^<]*)<\/v>/.exec(c.inner)?.[1];
  return v === undefined ? '' : unesc(v);
}

type Sheet = { rows: { r: number; open: string; cells: Cell[] }[]; before: string; after: string };

function parseSheet(xml: string): Sheet {
  const a = xml.indexOf('<sheetData');
  const b = xml.indexOf('</sheetData>');
  if (a < 0 || b < 0) {
    // An empty sheet: <sheetData/>.
    const s = xml.indexOf('<sheetData/>');
    return { rows: [], before: s < 0 ? xml : `${xml.slice(0, s)}<sheetData>`, after: s < 0 ? '' : `</sheetData>${xml.slice(s + 12)}` };
  }
  const openEnd = xml.indexOf('>', a) + 1;
  const body = xml.slice(openEnd, b);
  const rows: Sheet['rows'] = [];
  const re = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const r = Number(/\br="(\d+)"/.exec(m[1]!)?.[1] ?? 0);
    rows.push({ r, open: m[1]!, cells: parseCells(m[2] ?? '') });
  }
  return { rows, before: xml.slice(0, openEnd), after: xml.slice(b) };
}

const writeSheet = (s: Sheet) => s.before + s.rows.map((x) => (x.cells.length ? `<row${x.open}>${x.cells.map(writeCell).join('')}</row>` : `<row${x.open}/>`)).join('') + s.after;

/** Sets a cell to a number (null: empty), keeping its style; adds the cell when the row has none. */
function setNumber(row: Sheet['rows'][number], col: string, v: number | null) {
  let c = row.cells.find((x) => x.col === col);
  if (!c) {
    if (v === null) return;
    c = { col, row: row.r, attrs: ` r="${col}${row.r}"`, inner: null };
    const at = row.cells.findIndex((x) => colIndex(x.col) > colIndex(col));
    if (at < 0) row.cells.push(c); else row.cells.splice(at, 0, c);
  }
  c.attrs = c.attrs.replace(/\s+t="[^"]*"/, '');
  c.inner = v === null || !Number.isFinite(v) ? null : `<v>${v}</v>`;
}

/** Formula cells lose their saved result, so nothing old shows before Excel recalculates. */
function dropResults(s: Sheet) {
  for (const row of s.rows) {
    for (const c of row.cells) {
      if (c.inner && /<f[\s>/]/.test(c.inner)) {
        c.inner = c.inner.replace(/<v>[\s\S]*?<\/v>/, '');
        c.attrs = c.attrs.replace(/\s+t="(str|e|b|n)"/, '');
      }
    }
  }
}

/** The header row (a cell "Pack") and its columns by name. */
function header(s: Sheet, shared: string[]): { at: number; pack: string; cols: Map<string, string> } | null {
  for (let i = 0; i < s.rows.length; i++) {
    const cells = s.rows[i]!.cells;
    const p = cells.find((c) => norm(cellText(c, shared)) === 'pack');
    if (!p) continue;
    const cols = new Map<string, string>();
    for (const c of cells) if (c !== p) { const t = norm(cellText(c, shared)); if (t && !cols.has(t)) cols.set(t, c.col); }
    return { at: i, pack: p.col, cols };
  }
  return null;
}

const isTotal = (name: string) => /^(total|grand total|sub ?total)\b/i.test(name.trim());

function readShared(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unesc([...m[1]!.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join('')));
}

/** The template's file with the month's numbers. */
export function fillApprovalTemplate(file: Uint8Array, inp: TemplateInput): TemplateResult {
  const zip = unzipSync(file);
  const text = (p: string) => (zip[p] ? strFromU8(zip[p]!) : undefined);
  const put = (p: string, s: string) => { zip[p] = strToU8(s); };
  const shared = readShared(text('xl/sharedStrings.xml'));
  const month = MONTHS[Number(inp.period.slice(5)) - 1] ?? inp.period;
  const year = inp.period.slice(0, 4);

  // The sheets in workbook order, with their files.
  let wb = text('xl/workbook.xml') ?? '';
  const rels = text('xl/_rels/workbook.xml.rels') ?? '';
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/\bId="([^"]+)"/.exec(m[0])?.[1] ?? '', /\bTarget="([^"]+)"/.exec(m[0])?.[1] ?? '']));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const t = target.get(/\br:id="([^"]+)"/.exec(m[0])?.[1] ?? '') ?? '';
    return { tag: m[0], name: unesc(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? ''), path: t.startsWith('/') ? t.slice(1) : `xl/${t}` };
  });
  if (!sheets.length) throw new Error('The approval template has no sheets.');
  const first = sheets[0]!;
  const byMgr = sheets.find((s) => /by\s*manager/i.test(s.name)) ?? sheets[1];

  const used = new Set<string>();
  const unknown: string[] = [];
  // A row's packs: the pack itself, or both packs of a combined row ("CSD_SSPET500/400" = CSD_SSPET500 + CSD_SSPET400).
  const codesOf = (name: string): string[] => {
    const one = inp.codeOf(name);
    if (one) return [one];
    const m = /^(.*?)(\d+)((?:\s*[/+]\s*\d+)+)$/.exec(name.trim());
    if (!m) return [];
    const list = [m[2]!, ...m[3]!.split(/[/+]/).map((x) => x.trim()).filter(Boolean)].map((n) => inp.codeOf(`${m[1]}${n}`));
    return list.every(Boolean) ? (list as string[]) : [];
  };
  const sumOf = (g: Grid, codes: string[]) => (codes.some((c) => g[c] !== undefined) ? Math.round(codes.reduce((t, c) => t + (g[c] ?? 0), 0) * 100) / 100 : null);

  // ----- sheet 1: TARGET, YAGO, PAGO, PLAN per pack -----
  const s1x = text(first.path);
  if (s1x) {
    const s = parseSheet(s1x);
    const h = header(s, shared);
    if (h) {
      const col = (names: string[]) => names.map((n) => h.cols.get(n)).find(Boolean) ?? null;
      const cols: [string | null, Grid][] = [[col(['target', 'new target']), inp.target], [col(['yago']), inp.yago], [col(['pago']), inp.pago], [col(['plan', 'aop']), inp.plan]];
      for (const row of s.rows.slice(h.at + 1)) {
        const name = cellText(row.cells.find((c) => c.col === h.pack), shared).trim();
        if (!name || isTotal(name)) continue;
        if (/^(som|pack mix)$/i.test(name)) break; // the Pack Mix table below the packs
        const codes = codesOf(name);
        if (!codes.length) unknown.push(name);
        codes.forEach((c) => used.add(c));
        for (const [c, g] of cols) if (c) setNumber(row, c, codes.length ? sumOf(g, codes) : null);
      }
    }
    dropResults(s);
    put(first.path, writeSheet(s));
  }

  // ----- By Manager: target per pack and channel; the month in the date cell -----
  const s2x = byMgr && byMgr !== first ? text(byMgr.path) : undefined;
  if (byMgr && s2x) {
    const s = parseSheet(s2x);
    const h = header(s, shared);
    if (h) {
      const chanCol = inp.channels.map((c) => {
        const k = squash(c.label);
        const hit = [...h.cols.entries()].find(([n]) => squash(n) === k);
        return { col: hit?.[1] ?? null, g: c.g };
      });
      for (const row of s.rows.slice(h.at + 1)) {
        const name = cellText(row.cells.find((c) => c.col === h.pack), shared).trim();
        if (!name || isTotal(name)) continue;
        const codes = codesOf(name);
        for (const c of chanCol) if (c.col) setNumber(row, c.col, codes.length ? sumOf(c.g, codes) ?? 0 : null);
      }
      // The month cell above the header (a date).
      const serial = Math.round(Date.UTC(Number(year), Number(inp.period.slice(5)) - 1, 1) / 864e5) + 25569;
      for (const row of s.rows.slice(0, h.at)) {
        for (const c of row.cells) {
          const v = Number(/<v>([^<]*)<\/v>/.exec(c.inner ?? '')?.[1]);
          if (!/\bt="/.test(c.attrs) && !/<f[\s>/]/.test(c.inner ?? '') && v > 30000 && v < 80000) c.inner = `<v>${serial}</v>`;
        }
      }
    }
    dropResults(s);
    put(byMgr.path, writeSheet(s));
  }

  // ----- the month: titles (text boxes, shared strings) and the first sheet's name -----
  const retitle = (s: string) => s.replace(MONTH_RE, (_m, _mo, sp: string, _y, rest: string) => `${month}${sp}${year}${rest}`);
  for (const p of Object.keys(zip)) {
    if (/^xl\/drawings\/drawing\d+\.xml$/.test(p) || p === 'xl/sharedStrings.xml') put(p, retitle(text(p)!));
  }
  if (MONTHS.some((m) => m.toLowerCase() === first.name.trim().toLowerCase()) && !sheets.some((x) => x !== first && x.name.toLowerCase() === month.toLowerCase())) {
    const old = first.name;
    wb = wb.replace(first.tag, first.tag.replace(/\bname="[^"]*"/, `name="${esc(month)}"`));
    // Print area and other names that point at the sheet.
    wb = wb.replace(/(<definedName\b[^>]*>)([^<]*)(<\/definedName>)/g, (_m, a: string, body: string, z: string) =>
      a + body.split(`'${esc(old)}'!`).join(`'${esc(month)}'!`).split(`${esc(old)}!`).join(`${esc(month)}!`) + z);
  }
  // Excel works out every formula when the file opens; the old calculation chain goes.
  wb = /<calcPr\b[^>]*\/>/.test(wb)
    ? wb.replace(/<calcPr\b([^>]*?)\/>/, (_m, a: string) => `<calcPr${a.replace(/\s+fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`)
    : wb.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
  put('xl/workbook.xml', wb);
  if (zip['xl/calcChain.xml']) {
    delete zip['xl/calcChain.xml'];
    put('xl/_rels/workbook.xml.rels', rels.replace(/<Relationship\b[^>]*calcChain[^>]*\/>/, ''));
    const ct = text('[Content_Types].xml');
    if (ct) put('[Content_Types].xml', ct.replace(/<Override\b[^>]*calcChain[^>]*\/>/, ''));
  }

  const missing = Object.keys(inp.target).filter((p) => (inp.target[p] ?? 0) !== 0 && !used.has(p));
  return { data: zipSync(zip, { level: 6 }), missing, unknown };
}
