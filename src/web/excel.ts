// Spreadsheet helpers shared by the admin screens (route mapping now, forecast upload later).
// Both libraries are the browser builds; they are loaded on first use so the main bundle stays small.

/** Reads one sheet (the first when no name is given) as rows of cells. Throws if the file is not a readable .xlsx. */
export async function readSheet(file: File, sheetName?: string): Promise<unknown[][]> {
  const { readSheet: read } = await import('read-excel-file/browser');
  const rows = sheetName === undefined ? await read(file) : await read(file, sheetName);
  return rows as unknown[][];
}

/** Every sheet of the workbook, in order, with its name. Throws if the file is not a readable .xlsx. */
export async function readSheets(file: File): Promise<{ sheet: string; data: unknown[][] }[]> {
  const { default: readAll } = await import('read-excel-file/browser');
  return (await readAll(file)) as { sheet: string; data: unknown[][] }[];
}

export type CellKind = 'string' | 'number';

/** Turns rows into write-excel-file cells. With `kinds`, each column is written as that type
 * (codes such as route "0314" stay text with their leading zero; cases stay numbers). */
export function toCells(rows: (string | number)[][], kinds?: CellKind[]): { value: string | number; type?: StringConstructor | NumberConstructor }[][] {
  return rows.map((r) => r.map((v, i) => {
    const kind = kinds?.[i];
    if (kind === 'string') return { value: String(v), type: String };
    if (kind === 'number') return { value: typeof v === 'number' ? v : Number(v), type: Number };
    return { value: v };
  }));
}

/** Builds an .xlsx with a bold header row and downloads it. `kinds` fixes the cell type per column. */
export async function writeXlsx(fileName: string, columns: string[], rows: (string | number)[][], kinds?: CellKind[]): Promise<void> {
  const { default: write } = await import('write-excel-file/browser');
  const header = columns.map((value) => ({ value, fontWeight: 'bold' as const }));
  await write([header, ...toCells(rows, kinds)] as never).toFile(fileName);
}
