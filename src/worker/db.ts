// Thin typed helpers over D1. All SQL stays in the callers; these only bind,
// run and chunk.

/**
 * D1 Free allows 50 queries per Worker invocation (docs/decisions.md), and the
 * cap is per REQUEST, not per db.batch() call. A request already spends
 * queries on session lookup, authorization, version checks and audit, so one
 * batch gets a budget of 40 for the whole request. Bulk work must therefore be
 * set-based SQL (insertJson, or `... WHERE id IN (SELECT value FROM json_each(?))`),
 * never one statement per row.
 */
export const MAX_STATEMENTS_PER_REQUEST = 40;

/** Largest row count insertJson accepts in one call. */
export const MAX_INSERT_ROWS = 200;

export type Bindable = string | number | boolean | null | ArrayBuffer;

function bind(db: D1Database, sql: string, args: Bindable[]): D1PreparedStatement {
  const stmt = db.prepare(sql);
  return args.length ? stmt.bind(...args) : stmt;
}

/** First row, or null when the query returns none. */
export async function one<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...args: Bindable[]
): Promise<T | null> {
  return bind(db, sql, args).first<T>();
}

/** All rows. */
export async function all<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...args: Bindable[]
): Promise<T[]> {
  const res = await bind(db, sql, args).all<T>();
  return res.results;
}

/** Execute a write. */
export async function run(
  db: D1Database,
  sql: string,
  ...args: Bindable[]
): Promise<{ changes: number; lastRowId: number }> {
  const res = await bind(db, sql, args).run();
  return { changes: res.meta.changes ?? 0, lastRowId: res.meta.last_row_id ?? 0 };
}

/**
 * Run prepared statements as ONE atomic db.batch(). Throws before touching the
 * database when more than MAX_STATEMENTS_PER_REQUEST are passed: splitting
 * would both exceed the per-request query cap and lose atomicity.
 */
export async function batch(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  if (stmts.length > MAX_STATEMENTS_PER_REQUEST) {
    throw new Error(`D1 statement budget exceeded: ${stmts.length} > ${MAX_STATEMENTS_PER_REQUEST}`);
  }
  if (stmts.length === 0) return [];
  return db.batch(stmts);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`insertJson: unsafe identifier "${name}"`);
  return name;
}

/**
 * Bulk insert as ONE statement with ONE bound parameter:
 *   INSERT INTO t (a, b) SELECT json_extract(value,'$.a'), json_extract(value,'$.b')
 *   FROM json_each(?) WHERE true [onConflict]
 * Keeps a 200-row batch to a single query (50-queries cap) and one bound
 * parameter (100-params cap). At most MAX_INSERT_ROWS (200) rows per call.
 *
 * Column values may be string, number, boolean (stored 1/0) or null. A JSON
 * string stays a string, so pass `values_json`-style columns already
 * stringified. `table` and `columns` are interpolated into SQL, so they are
 * validated as plain identifiers. `onConflict` is trusted SQL appended after
 * the SELECT, e.g. "ON CONFLICT(code) DO UPDATE SET name = excluded.name".
 */
export function insertJsonStatement(
  db: D1Database,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  opts: { onConflict?: string } = {},
): D1PreparedStatement {
  if (rows.length > MAX_INSERT_ROWS) {
    throw new Error(`insertJson: ${rows.length} rows exceeds the ${MAX_INSERT_ROWS}-row batch limit`);
  }
  const t = ident(table);
  const cols = columns.map(ident);
  const select = cols.map((c) => `json_extract(value, '$.${c}')`).join(', ');
  // "WHERE true" avoids SQLite's INSERT..SELECT / ON CONFLICT parse ambiguity.
  const sql =
    `INSERT INTO ${t} (${cols.join(', ')}) SELECT ${select} FROM json_each(?) WHERE true` +
    (opts.onConflict ? ` ${opts.onConflict}` : '');
  const projected = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
  return db.prepare(sql).bind(JSON.stringify(projected));
}

export async function insertJson(
  db: D1Database,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
  opts: { onConflict?: string } = {},
): Promise<void> {
  if (rows.length === 0) return;
  await insertJsonStatement(db, table, columns, rows, opts).run();
}
