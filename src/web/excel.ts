// Spreadsheet helpers shared by the admin screens (route mapping now, forecast upload later).
// Both libraries are the browser builds; they are loaded on first use so the main bundle stays small.

/** Reads one sheet (the first when no name is given) as rows of cells. Throws if the file is not a readable .xlsx. */
export async function readSheet(file: File, sheetName?: string): Promise<unknown[][]> {
  const { readSheet: read } = await import('read-excel-file/browser');
  const rows = sheetName === undefined ? await read(file) : await read(file, sheetName);
  return rows as unknown[][];
}

/** Builds an .xlsx with a bold header row and downloads it. */
export async function writeXlsx(fileName: string, columns: string[], rows: (string | number)[][]): Promise<void> {
  const { default: write } = await import('write-excel-file/browser');
  const header = columns.map((value) => ({ value, fontWeight: 'bold' as const }));
  const body = rows.map((r) => r.map((value) => ({ value })));
  await write([header, ...body] as never).toFile(fileName);
}
