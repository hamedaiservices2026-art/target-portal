// Route-mapping file: finding the header, turning sheet rows into API rows, and
// turning the server's line errors into sentences. No i18n or DOM here (unit-tested in Node).

export const MAPPING_COLUMNS = ['Delivery System', 'Route Code', 'Node', 'Label'] as const;
export const MAPPING_MAX_ROWS = 5000;
const HEADER_SCAN_ROWS = 30;

export type MappingRow = { deliverySystem: string; routeCode: string; nodeName: string; label?: string };
export type ParsedMapping =
  | { ok: true; rows: MappingRow[]; excelRows: number[] }
  | { ok: false; reason: 'no_header' | 'no_rows' | 'too_many'; count?: number };

const norm = (v: unknown): string => String(v ?? '').toLowerCase().replace(/\s+/g, '');
const cell = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim());

/**
 * `sheet` is the raw rows of the first sheet. The header row is the first one (among the first 30) that
 * names Delivery System, Route Code and Node (case and spaces ignored); Label is optional. Blank rows are
 * skipped. `excelRows[i]` is the 1-based sheet row of `rows[i]`.
 */
export function parseMappingSheet(sheet: unknown[][]): ParsedMapping {
  const want = MAPPING_COLUMNS.map(norm);
  let header = -1;
  let cols: number[] = [];
  for (let r = 0; r < Math.min(sheet.length, HEADER_SCAN_ROWS); r++) {
    const names = (sheet[r] ?? []).map(norm);
    const idx = want.map((w) => names.indexOf(w));
    if (idx[0]! >= 0 && idx[1]! >= 0 && idx[2]! >= 0) {
      header = r;
      cols = idx;
      break;
    }
  }
  if (header < 0) return { ok: false, reason: 'no_header' };

  const rows: MappingRow[] = [];
  const excelRows: number[] = [];
  for (let r = header + 1; r < sheet.length; r++) {
    const line = sheet[r] ?? [];
    const deliverySystem = cell(line[cols[0]!]);
    const routeCode = cell(line[cols[1]!]);
    const nodeName = cell(line[cols[2]!]);
    const label = cols[3]! >= 0 ? cell(line[cols[3]!]) : '';
    if (!deliverySystem && !routeCode && !nodeName && !label) continue;
    rows.push(label ? { deliverySystem, routeCode, nodeName, label } : { deliverySystem, routeCode, nodeName });
    excelRows.push(r + 1);
  }
  if (rows.length === 0) return { ok: false, reason: 'no_rows' };
  if (rows.length > MAPPING_MAX_ROWS) return { ok: false, reason: 'too_many', count: rows.length };
  return { ok: true, rows, excelRows };
}

export type LineError = { line: number; detail: string };
export type ExplainedError = { excelRow: number; kind: string; vars: Record<string, string | number> };

/**
 * Server lines count the sent rows from 2 (index + 2); the person sees sheet rows. `kind` is an i18n key suffix
 * ('required', 'unknownNode', 'duplicate', 'otherDept', 'tooLong', 'other'); the English detail is kept as `vars.detail`.
 */
export function explainErrors(errors: LineError[], excelRows: number[]): ExplainedError[] {
  const excel = (line: number) => excelRows[line - 2] ?? line;
  const out: ExplainedError[] = [];
  for (const e of errors) {
    const base = { excelRow: excel(e.line) };
    for (const part of e.detail.split('; ')) {
      let m: RegExpExecArray | null;
      if ((m = /^(deliverySystem|routeCode|nodeName) is required$/.exec(part))) {
        const field = m[1] === 'deliverySystem' ? MAPPING_COLUMNS[0] : m[1] === 'routeCode' ? MAPPING_COLUMNS[1] : MAPPING_COLUMNS[2];
        out.push({ ...base, kind: 'required', vars: { column: field } });
      } else if ((m = /^unknown node "(.*)" in this department$/.exec(part))) {
        out.push({ ...base, kind: 'unknownNode', vars: { node: m[1]! } });
      } else if ((m = /^duplicate of line (\d+) /.exec(part))) {
        out.push({ ...base, kind: 'duplicate', vars: { other: excel(Number(m[1])) } });
      } else if (/^route is already mapped in a different department$/.test(part)) {
        out.push({ ...base, kind: 'otherDept', vars: {} });
      } else if (/ at most \d+ characters$|must be a non-blank string/.test(part)) {
        out.push({ ...base, kind: 'tooLong', vars: {} });
      } else {
        out.push({ ...base, kind: 'other', vars: { detail: part } });
      }
    }
  }
  return out;
}
