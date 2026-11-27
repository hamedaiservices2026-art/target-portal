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
  /**
   * Channel column label -> target by pack (the "By Manager" sheet). `alias`:
   * other names of the channel (its Head's name and code, for the Mix sheet);
   * `sales`: the channel's sales by month and pack (YAGO sheet, Mix sheet).
   */
  channels: { label: string; g: Grid; alias?: string[]; sales?: Record<string, Grid> }[];
  /** Category of a pack code (CSD, Water, LRB-Others): the Mix sheet is CSD. */
  catOf?: (code: string) => string;
  /** A row's pack name -> pack code (null: not a pack of the master). */
  codeOf: (name: string) => string | null;
};

export type TemplateResult = {
  data: Uint8Array;
  /** Packs with a target that the template has no row for. */
  missing: string[];
  /** Rows of the template whose name is not a known pack (their numbers are cleared). */
  unknown: string[];
  /** Department rows of the Mix sheet that match no channel (their numbers are cleared). */
  unmatched: string[];
  /** The template is a macro-enabled workbook (.xlsm). */
  macro: boolean;
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



/** A cell reference outside function names (LOG10 is not a cell). */
const REF_RE = /(?<![A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])/g;

/**
 * Shared formulas written out in full on each cell, so a cell can be changed
 * or copied without breaking the cells that share its formula.
 */
function unshare(s: Sheet) {
  const masters = new Map<string, { f: string; col: number; row: number }>();
  for (const row of s.rows) for (const c of row.cells) {
    const m = /<f\b([^>]*)>([\s\S]*?)<\/f>/.exec(c.inner ?? '');
    if (m && /\bt="shared"/.test(m[1]!) && m[2]) masters.set(/\bsi="(\d+)"/.exec(m[1]!)?.[1] ?? '', { f: unesc(m[2]), col: colIndex(c.col), row: c.row });
  }
  const colName = (i: number) => { let n = i + 1; let out = ''; while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); } return out; };
  for (const row of s.rows) for (const c of row.cells) {
    const m = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(c.inner ?? '');
    if (!m || !/\bt="shared"/.test(m[1]!)) continue;
    const ms = masters.get(/\bsi="(\d+)"/.exec(m[1]!)?.[1] ?? '');
    if (!ms) continue;
    const dr = c.row - ms.row;
    const dc = colIndex(c.col) - ms.col;
    const f = ms.f.replace(REF_RE, (_x, d1: string, col: string, d2: string, r: string) =>
      `${d1}${d1 ? col : colName(colIndex(col) + dc)}${d2}${d2 ? r : Number(r) + dr}`);
    c.inner = c.inner!.replace(m[0], `<f>${esc(f)}</f>`);
  }
}

/** Whether a cell holds a formula. */
const hasFormula = (c: Cell | undefined) => !!c?.inner && /<f[\s>/]/.test(c.inner);
const formulaOf = (c: Cell | undefined) => (c?.inner ? unesc(/<f[^>]*>([\s\S]*?)<\/f>/.exec(c.inner)?.[1] ?? '') : '');
const isEmpty = (c: Cell | undefined) => !c || !c.inner || (!/<v>/.test(c.inner) && !hasFormula(c) && !/<is>/.test(c.inner));

/** Sets a cell to a formula (no saved result), keeping its style; adds the cell when the row has none. */
function setFormula(row: Sheet['rows'][number], col: string, f: string) {
  let c = row.cells.find((x) => x.col === col);
  if (!c) {
    c = { col, row: row.r, attrs: ` r="${col}${row.r}"`, inner: null };
    const at = row.cells.findIndex((x) => colIndex(x.col) > colIndex(col));
    if (at < 0) row.cells.push(c); else row.cells.splice(at, 0, c);
  }
  c.attrs = c.attrs.replace(/\s+t="[^"]*"/, '');
  c.inner = `<f>${esc(f)}</f>`;
}

/**
 * A formula of one sheet rewritten for another sheet of the same layout:
 * each reference goes to the row with the same name and the column with the
 * same header (the cell's own column follows the cell). Null when a reference
 * has no match, refers to another sheet, or there is no reference at all.
 */
function translate(f: string, rowTo: (r: number) => number | null, colTo: (c: string) => string | null): string | null {
  if (/!/.test(f) || !/[A-Z]{1,3}\$?\d/.test(f)) return null;
  let ok = true;
  const out = f.replace(REF_RE, (_m, d1: string, c: string, d2: string, r: string) => {
    const nc = colTo(c);
    const nr = rowTo(Number(r));
    if (!nc || nr === null) { ok = false; return _m; }
    return `${d1}${nc}${d2}${nr}`;
  });
  return ok ? out : null;
}

const isTotal = (name: string) => /^(total|grand total|sub ?total)\b/i.test(name.trim());

function readShared(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unesc([...m[1]!.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join('')));
}

type Head = { at: number; pack: string; cols: Map<string, string> };

/**
 * The totals of a by-channel sheet (By Manager, YAGO sales) rebuilt so every
 * sheet adds up the same way, whatever the template held (typed numbers, old
 * formulas, empty cells):
 * - a pack row: "Total TT" = its channels, "ABC" = the totals + the other channels;
 * - a total row ("Total CANS", "Total CSD"...): the formula of the same row of
 *   the first sheet's target column, applied to each column.
 * Rows after the last total row (notes, signatures) are left alone.
 */
function rebuildTotals(s: Sheet, h: Head, shared: string[], channels: Set<string>, first: { sheet: Sheet; h: Head } | null, codesOf: (name: string) => string[]) {
  const head = s.rows[h.at]!;
  const ordered = head.cells.filter((c) => colIndex(c.col) > colIndex(h.pack)).sort((a, b) => colIndex(a.col) - colIndex(b.col));
  type Col = { col: string; kind: 'chan' | 'total' | 'grand'; members: string[] };
  const cols: Col[] = [];
  let open: string[] = [];
  for (const c of ordered) {
    const name = norm(cellText(c, shared));
    if (!name) continue;
    if (name === 'abc' || name === 'grand total' || name === 'total') {
      const inTotals = new Set(cols.filter((x) => x.kind === 'total').flatMap((x) => x.members));
      cols.push({ col: c.col, kind: 'grand', members: cols.filter((x) => x.kind === 'total' || (x.kind === 'chan' && !inTotals.has(x.col))).map((x) => x.col) });
      break;
    }
    if (cols.some((x) => norm(cellText(head.cells.find((y) => y.col === x.col), shared)) === name)) break; // a second block (growth %)
    if (/^total\b/.test(name)) { cols.push({ col: c.col, kind: 'total', members: open }); open = []; continue; }
    if (channels.has(squash(name))) { cols.push({ col: c.col, kind: 'chan', members: [] }); open.push(c.col); continue; }
    break;
  }
  if (!cols.some((x) => x.kind !== 'chan')) return;
  const nameOf = (sh: Sheet, hh: Head, row: Sheet['rows'][number]) => norm(cellText(row.cells.find((c) => c.col === hh.pack), shared));
  const body = s.rows.slice(h.at + 1);
  let last = -1;
  body.forEach((row, i) => { if (isTotal(nameOf(s, h, row))) last = i; });
  // Rows by name, and by pack (a row "CSD_SSPET500" here is "CSD_SSPET500/400" on the first sheet).
  const myRows = new Map<string, number>();
  const byCode = new Map<string, number>();
  const codeKey = (n: string) => (isTotal(n) ? '' : codesOf(n).sort().join('|'));
  for (const row of body.slice(0, last + 1)) {
    const n = nameOf(s, h, row);
    if (n && !myRows.has(n)) myRows.set(n, row.r);
    const k = n ? codeKey(cellText(row.cells.find((c) => c.col === h.pack), shared).trim()) : '';
    if (k && !byCode.has(k)) byCode.set(k, row.r);
  }
  const fcol = first ? (first.h.cols.get('new target') ?? first.h.cols.get('target')) : undefined;
  for (const row of body.slice(0, last + 1)) {
    const name = nameOf(s, h, row);
    if (!name) continue;
    if (!isTotal(name)) {
      for (const c of cols) if (c.kind !== 'chan' && c.members.length) setFormula(row, c.col, c.members.map((m) => `${m}${row.r}`).join('+'));
      continue;
    }
    if (!first || !fcol) continue;
    const srow = first.sheet.rows.slice(first.h.at + 1).find((r) => nameOf(first.sheet, first.h, r) === name);
    const f = formulaOf(srow?.cells.find((c) => c.col === fcol));
    if (!f) continue;
    const rowTo = (r: number) => {
      const sr = first.sheet.rows.find((x) => x.r === r);
      const n = sr ? nameOf(first.sheet, first.h, sr) : '';
      if (!n) return null;
      const k = myRows.get(n) ?? byCode.get(codeKey(cellText(sr!.cells.find((c) => c.col === first.h.pack), shared).trim()));
      return k ?? null;
    };
    for (const c of cols) {
      const t = translate(f, rowTo, (x) => (x === fcol ? c.col : null));
      if (t) setFormula(row, c.col, t);
    }
  }
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
    // The packs of the row that exist (a size no longer sold is simply not there).
    const list = [m[2]!, ...m[3]!.split(/[/+]/).map((x) => x.trim()).filter(Boolean)].map((n) => inp.codeOf(`${m[1]}${n}`)).filter(Boolean) as string[];
    return [...new Set(list)];
  };
  const chanKeys = new Set(inp.channels.flatMap((c) => [c.label, ...(c.alias ?? [])]).map(squash).filter(Boolean));
  const firstSrc = () => { const src = parseSheet(text(first.path) ?? ''); unshare(src); const hh = header(src, shared); return hh ? { sheet: src, h: hh } : null; };
  const sumOf = (g: Grid, codes: string[]) => (codes.some((c) => g[c] !== undefined) ? Math.round(codes.reduce((t, c) => t + (g[c] ?? 0), 0) * 100) / 100 : null);

  // ----- sheet 1: TARGET, YAGO, PAGO, PLAN per pack -----
  const s1x = text(first.path);
  if (s1x) {
    const s = parseSheet(s1x);
    unshare(s);
    const h = header(s, shared);
    if (h) {
      const col = (names: string[]) => names.map((n) => h.cols.get(n)).find(Boolean) ?? null;
      const cols: [string | null, Grid][] = [[col(['target', 'new target']), inp.target], [col(['yago', 'yago sales']), inp.yago],
        [col(['pago', 'pago sales']), inp.pago], [col(['plan', 'aop', 'aop plan']), inp.plan]];
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
    unshare(s);
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
      rebuildTotals(s, h, shared, chanKeys, firstSrc(), codesOf);
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


  // ----- YAGO sales by channel (a sheet named "YAGO ...", same layout as By Manager) -----
  const yagoMonth = `${Number(year) - 1}-${inp.period.slice(5)}`;
  const yagoSheet = sheets.find((x) => x !== first && x !== byMgr && /yago/i.test(x.name));
  const ysx = yagoSheet ? text(yagoSheet.path) : undefined;
  if (yagoSheet && ysx) {
    const s = parseSheet(ysx);
    unshare(s);
    const h = header(s, shared);
    // Where the totals' formulas come from: By Manager (same columns), else the first sheet's target column.
    const sources = [byMgr && byMgr !== first ? byMgr : null, first].filter(Boolean).map((x) => {
      const src = parseSheet(text(x!.path) ?? '');
      unshare(src);
      return { sheet: src, h: header(src, shared), isFirst: x === first };
    }).filter((x) => x.h);
    if (h) {
      const nameOfRow = (sh: Sheet, hh: { pack: string }, row: Sheet['rows'][number]) => norm(cellText(row.cells.find((c) => c.col === hh.pack), shared));
      const myRows = new Map<string, number>();
      for (const row of s.rows.slice(h.at + 1)) { const n = nameOfRow(s, h, row); if (n && !myRows.has(n)) myRows.set(n, row.r); }
      const chanCol = new Map<string, { g: Record<string, Grid> | undefined }>();
      for (const c of inp.channels) {
        const k = squash(c.label);
        const hit = [...h.cols.entries()].find(([n]) => squash(n) === k);
        if (hit) chanCol.set(hit[1], { g: c.sales });
      }
      for (const row of s.rows.slice(h.at + 1)) {
        const name = cellText(row.cells.find((c) => c.col === h.pack), shared).trim();
        if (!name) continue;
        const total = isTotal(name);
        const codes = total ? [] : codesOf(name);
        for (const [hn, col] of h.cols) {
          const cell = row.cells.find((c) => c.col === col);
          const ch = chanCol.get(col);
          if (ch && !total) { if (!hasFormula(cell)) setNumber(row, col, codes.length ? sumOf(ch.g?.[yagoMonth] ?? {}, codes) ?? 0 : null); continue; }
          if (!isEmpty(cell)) continue;
          // A total row or a total column: the formula of the same cell of By Manager (or of the first sheet).
          for (const src of sources) {
            const sh = src.h!;
            const srow = src.sheet.rows.slice(sh.at + 1).find((r) => nameOfRow(src.sheet, sh, r) === norm(name));
            if (!srow) continue;
            const scol = src.isFirst ? (sh.cols.get('new target') ?? sh.cols.get('target')) : sh.cols.get(hn);
            if (!scol) continue;
            const f = formulaOf(srow.cells.find((c) => c.col === scol));
            if (!f) continue;
            const rowTo = (r: number) => {
              const sr = src.sheet.rows.find((x) => x.r === r);
              const n = sr ? nameOfRow(src.sheet, sh, sr) : '';
              return n ? myRows.get(n) ?? null : null;
            };
            const colTo = (c: string) => {
              if (c === scol) return col;
              if (src.isFirst) return null;
              const hname = [...sh.cols.entries()].find(([, v]) => v === c)?.[0];
              return hname ? h.cols.get(hname) ?? null : null;
            };
            const t = translate(f, rowTo, colTo);
            if (t) { setFormula(row, col, t); break; }
          }
        }
      }
    }
    if (h) rebuildTotals(s, h, shared, chanKeys, firstSrc(), codesOf);
    dropResults(s);
    put(yagoSheet.path, writeSheet(s));
  }

  // ----- Mix: CSD share of market (SOM %), PAGO, YAGO and target by department -----
  const unmatched: string[] = [];
  const mixSheet = sheets.find((x) => x !== first && /\bmix\b/i.test(x.name));
  const msx = mixSheet ? text(mixSheet.path) : undefined;
  if (mixSheet && msx && inp.catOf) {
    const catOf = inp.catOf;
    const s = parseSheet(msx);
    unshare(s);
    const mo = Number(inp.period.slice(5));
    const y = Number(year);
    const ym = (yy: number, m: number) => `${yy}-${String(m).padStart(2, '0')}`;
    const range = (yy: number, from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => ym(yy, from + i));
    const back = (k: number) => { const d = new Date(Date.UTC(y, mo - 1 - k, 1)); return ym(d.getUTCFullYear(), d.getUTCMonth() + 1); };
    const pagoM = back(1);
    const months = {
      fy: range(y - 1, 1, 12),
      ytd: mo > 1 ? range(y, 1, mo - 1) : [],
      ytdLy: mo > 1 ? range(y - 1, 1, mo - 1) : [],
      m3: [back(3), back(2), back(1)],
    };
    const csdOf = (g: Grid | undefined) => Object.entries(g ?? {}).reduce((t, [p, n]) => t + (catOf(p) === 'CSD' ? n : 0), 0);
    const salesOf = (c: (typeof inp.channels)[number], ms: string[]) => ms.reduce((t, m) => t + csdOf(c.sales?.[m]), 0);
    const all = (ms: string[]) => inp.channels.reduce((t, c) => t + salesOf(c, ms), 0);
    const share = (v: number, tot: number) => (tot > 0 ? v / tot : null);
    const r6 = (v: number | null) => (v === null ? null : Math.round(v * 1e6) / 1e6);
    const keys = (c: (typeof inp.channels)[number]) => [c.label, ...(c.alias ?? [])].map(squash).filter(Boolean);
    const match = (name: string) => {
      const k = squash(name);
      const k2 = squash(name.split(/\s+-\s+/)[0] ?? '');
      return inp.channels.find((c) => keys(c).includes(k)) ?? inp.channels.find((c) => keys(c).includes(k2)) ?? null;
    };
    // The category totals under "CSD Target", "WATER Target", ... (the cell below).
    for (let i = 0; i < s.rows.length; i++) {
      for (const c of s.rows[i]!.cells) {
        const m = /^(csd|water|lrb-others|lrb others)\s+target$/i.exec(cellText(c, shared).trim());
        if (!m) continue;
        const cat = m[1]!.toLowerCase().startsWith('csd') ? 'CSD' : m[1]!.toLowerCase().startsWith('water') ? 'Water' : 'LRB-Others';
        const below = s.rows.find((r) => r.r === s.rows[i]!.r + 1);
        const v = Object.entries(inp.target).reduce((t, [p, n]) => t + (catOf(p) === cat ? n : 0), 0);
        if (below && !hasFormula(below.cells.find((x) => x.col === c.col))) setNumber(below, c.col, Math.round(v));
      }
    }
    // The department table: the header row with "DEPARTMENT", rows down to "Grand Total".
    const hi = s.rows.findIndex((r) => r.cells.some((c) => norm(cellText(c, shared)) === 'department') && r.cells.length > 2);
    if (hi >= 0) {
      const hrow = s.rows[hi]!;
      const dcol = hrow.cells.find((c) => norm(cellText(c, shared)) === 'department')!.col;
      const colsBy = hrow.cells.filter((c) => c.col !== dcol).map((c) => ({ col: c.col, name: norm(cellText(c, shared)) }));
      type DRow = { row: Sheet['rows'][number]; name: string; ch: (typeof inp.channels)[number] | null; valueCells: typeof colsBy };
      const drows: DRow[] = [];
      for (const row of s.rows.slice(hi + 1)) {
        const name = cellText(row.cells.find((c) => c.col === dcol), shared).trim();
        if (!name) break;
        if (/^grand total$/i.test(name)) break;
        const valueCells = colsBy.filter((x) => !hasFormula(row.cells.find((c) => c.col === x.col)));
        // A total row: its name, or more formulas than numbers.
        if (isTotal(name) || valueCells.length * 2 < colsBy.length) continue;
        drows.push({ row, name, ch: match(name), valueCells });
      }
      // A row left over pairs with the one channel left over that starts with the same word ("MT WS" = "MT Bulk").
      const used = new Set(drows.map((d) => d.ch).filter(Boolean));
      for (const d of drows.filter((x) => !x.ch)) {
        const w = squash(d.name.split(/\s+/)[0] ?? '');
        const free = inp.channels.filter((c) => !used.has(c) && squash(c.label.split(/\s+/)[0] ?? '') === w);
        if (free.length === 1) { d.ch = free[0]!; used.add(free[0]!); }
      }
      for (const { row, name, ch, valueCells } of drows) {
        if (!ch) { unmatched.push(name); for (const x of valueCells) setNumber(row, x.col, null); continue; }
        for (const x of valueCells) {
          const n = x.name;
          let v: number | null | undefined;
          if (/^fy\s*\d{4}/.test(n)) v = r6(share(salesOf(ch, months.fy), all(months.fy)));
          else if (/^ytd sales$/.test(n)) v = r6(share(salesOf(ch, months.ytd), all(months.ytd)));
          else if (/^3\s*months?/.test(n)) v = r6(share(salesOf(ch, months.m3), all(months.m3)));
          else if (/^pago sales$/.test(n)) v = Math.round(salesOf(ch, [pagoM]) * 100) / 100;
          else if (/^yago sales$/.test(n)) v = Math.round(salesOf(ch, [yagoMonth]) * 100) / 100;
          else if (/target$/.test(n)) v = Math.round(csdOf(ch.g));
          else if (/^ytd.*growth/.test(n)) { const a = salesOf(ch, months.ytd); const b = salesOf(ch, months.ytdLy); v = b > 0 ? r6(a / b - 1) : null; }
          if (v !== undefined) setNumber(row, x.col, v);
        }
      }
    }
    dropResults(s);
    put(mixSheet.path, writeSheet(s));
  }

  // ----- the month: titles (text boxes, shared strings) and the first sheet's name -----
  const short = (i: number) => MONTHS[(i + 12) % 12]!.slice(0, 3);
  const mIdx = Number(inp.period.slice(5)) - 1;
  const caseLike = (like: string, v: string) => (like === like.toUpperCase() ? v.toUpperCase() : v);
  // Mix headers: "DEC SOM", "DEC Target", "YTD Nov Growth %", "FY 2025 Sales".
  const MON = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  const reheader = (t: string) => t
    .replace(new RegExp(`^${MON}(\\s+(?:SOM|Target))$`, 'i'), (_m, mo: string, rest: string) => caseLike(mo, short(mIdx)) + rest)
    .replace(new RegExp(`^(YTD\\s+)${MON}(\\s+Growth\\s*%)$`, 'i'), (_m, a: string, mo: string, z: string) => a + caseLike(mo, short(mIdx - 1)) + z)
    .replace(/^(FY\s+)\d{4}(\s+Sales)$/i, (_m, a: string, z: string) => `${a}${Number(year) - 1}${z}`);
  const retitle = (s: string) => s.replace(MONTH_RE, (_m, _mo, sp: string, _y, rest: string) => `${month}${sp}${year}${rest}`)
    .replace(/(<t(?:\s[^>]*)?>)([^<]*)(<\/t>)/g, (m, a: string, t: string, z: string) => { const r = reheader(unesc(t)); return r === unesc(t) ? m : a + esc(r) + z; });
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
  const macro = /macroEnabled/i.test(text('[Content_Types].xml') ?? '');
  return { data: zipSync(zip, { level: 6 }), missing, unknown, unmatched, macro };
}
