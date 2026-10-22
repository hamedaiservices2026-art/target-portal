// Bulk import from Excel (Task E): users, packs and the hierarchy tree.
//
// Pure code shared by the browser and the Worker, no I/O:
//   - parseImportSheet: the browser turns the sheet into rows of text cells;
//   - coerceImportRows: the Worker checks the shape of the rows it is sent;
//   - planUsers / planPacks / planHierarchy: given the rows and the current
//     data, what Apply would do (create / update / unchanged) and every problem,
//     by sheet row. The Worker runs the plan on preview AND again on apply (it
//     never trusts a preview the browser kept).
// Mode is add-and-update only: nothing is deleted or disabled, and records that
// are not in the file are left alone.

export const IMPORT_MAX_ROWS = 2000;
/** Longest cell the server accepts (the password limit); real limits per column are checked by the plans. */
export const IMPORT_MAX_CELL = 1024;

export type ImportKind = 'users' | 'packs' | 'hierarchy';

/** The template headers, in order. These English names are what the file must contain (case and spaces are ignored). */
export const IMPORT_COLUMNS = {
  users: ['Username', 'Full name', 'Role', 'Password', 'Language', 'Email'],
  packs: ['Code', 'Group', 'Sort order', 'Active'],
  hierarchy: ['Department', 'Node name', 'Parent node name', 'Manager username'],
} as const;

const FIELDS = {
  users: ['username', 'name', 'role', 'password', 'lang', 'email'],
  packs: ['code', 'grp', 'sort', 'active'],
  hierarchy: ['dept', 'node', 'parent', 'manager'],
} as const;

/** Header columns the file must have (the cells may still be blank where the column is optional). */
const REQUIRED_HEADERS: Record<ImportKind, number[]> = { users: [0, 1, 2], packs: [0, 1], hierarchy: [0, 1, 2] };

/** Other spellings accepted for each header (after lower-casing and removing spaces). */
const ALIASES: Record<ImportKind, string[][]> = {
  users: [['username', 'user'], ['fullname', 'name'], ['role'], ['password'], ['language', 'lang'], ['email', 'e-mail']],
  packs: [['code', 'packcode', 'pack'], ['group', 'grp', 'packgroup'], ['sortorder', 'sort', 'order'], ['active']],
  hierarchy: [['department', 'dept', 'departmentcode'], ['nodename', 'node'], ['parentnodename', 'parentnode', 'parent'], ['managerusername', 'manager']],
};

export type UserImportRow = { line: number; username: string; name: string; role: string; password: string; lang: string; email: string };
export type PackImportRow = { line: number; code: string; grp: string; sort: string; active: string };
export type NodeImportRow = { line: number; dept: string; node: string; parent: string; manager: string };
export type ImportRowOf<K extends ImportKind> =
  K extends 'users' ? UserImportRow : K extends 'packs' ? PackImportRow : NodeImportRow;

export type IssueCode =
  | 'required' | 'too_long' | 'invalid_value' | 'invalid_username' | 'invalid_email'
  | 'password_short' | 'password_long' | 'duplicate' | 'self_demote' | 'user_disabled'
  | 'case_mismatch' | 'unknown_department' | 'unknown_manager' | 'manager_disabled'
  | 'unknown_parent' | 'parent_self' | 'cycle' | 'root_exists' | 'root_parent' | 'two_roots'
  | 'too_deep' | 'too_many_moves' | 'no_manager';

/** `line` is the sheet row (null: about the whole file). `column` is the template header. */
export type ImportIssue = {
  line: number | null; level: 'error' | 'warning'; code: IssueCode; column?: string; vars?: Record<string, string | number>;
};

export type ImportCounts = { create: number; update: number; unchanged: number };
export type ActionKind = 'create' | 'update' | 'unchanged';

// ---------------------------------------------------------------- sheet

export type ParsedImport<K extends ImportKind> =
  | { ok: true; rows: ImportRowOf<K>[] }
  | { ok: false; reason: 'no_header'; missing: string[] }
  | { ok: false; reason: 'no_rows' }
  | { ok: false; reason: 'too_many'; count: number };

const HEADER_SCAN_ROWS = 30;
const squash = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase().replace(/[\s_]+/g, '') : '');

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).trim();
}

/**
 * `sheet` is the raw rows of the first sheet. The header row is the first of the
 * first 30 rows that has every required column; missing optional columns read as
 * blank. Blank rows are skipped. Each row keeps its 1-based sheet row as `line`.
 */
export function parseImportSheet<K extends ImportKind>(kind: K, sheet: unknown[][]): ParsedImport<K> {
  const aliases = ALIASES[kind];
  const required = REQUIRED_HEADERS[kind];
  let header = -1;
  let cols: number[] = [];
  let bestMissing: number[] | null = null;
  for (let r = 0; r < Math.min(sheet.length, HEADER_SCAN_ROWS); r++) {
    const names = (sheet[r] ?? []).map(squash);
    const idx = aliases.map((alts) => names.findIndex((n) => alts.includes(n)));
    const missing = required.filter((i) => idx[i]! < 0);
    if (missing.length === 0) {
      header = r;
      cols = idx;
      break;
    }
    if (bestMissing === null || missing.length < bestMissing.length) bestMissing = missing;
  }
  if (header < 0) {
    const cols0 = IMPORT_COLUMNS[kind] as readonly string[];
    return { ok: false, reason: 'no_header', missing: (bestMissing ?? required).map((i) => cols0[i]!) };
  }
  const fields = FIELDS[kind] as readonly string[];
  const rows: Record<string, string | number>[] = [];
  for (let r = header + 1; r < sheet.length; r++) {
    const line = sheet[r] ?? [];
    const row: Record<string, string | number> = { line: r + 1 };
    let any = false;
    fields.forEach((f, i) => {
      const v = cols[i]! >= 0 ? cellText(line[cols[i]!]) : '';
      if (v) any = true;
      row[f] = v;
    });
    if (any) rows.push(row);
  }
  if (rows.length === 0) return { ok: false, reason: 'no_rows' };
  if (rows.length > IMPORT_MAX_ROWS) return { ok: false, reason: 'too_many', count: rows.length };
  return { ok: true, rows: rows as ImportRowOf<K>[] };
}

/** Server side: the rows as sent, checked for shape only (every field a string, a positive line). */
export function coerceImportRows<K extends ImportKind>(
  kind: K, raw: unknown,
): { ok: true; rows: ImportRowOf<K>[] } | { ok: false; detail: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, detail: 'rows must be a non-empty array' };
  const fields = FIELDS[kind] as readonly string[];
  const out: Record<string, string | number>[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, detail: `row ${i + 1} must be an object` };
    const line = r.line;
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > 1_000_000) {
      return { ok: false, detail: `row ${i + 1}: line must be a positive integer` };
    }
    const row: Record<string, string | number> = { line };
    for (const f of fields) {
      const v = r[f];
      if (v === undefined || v === null) row[f] = '';
      else if (typeof v !== 'string') return { ok: false, detail: `row ${i + 1}: ${f} must be a string` };
      else if (v.length > IMPORT_MAX_CELL) return { ok: false, detail: `row ${i + 1}: ${f} is too long` };
      else row[f] = v;
    }
    out.push(row);
  }
  return { ok: true, rows: out as ImportRowOf<K>[] };
}

// ---------------------------------------------------------------- shared checks

class Issues {
  readonly list: ImportIssue[] = [];
  private bad = new Set<number>();
  err(line: number, code: IssueCode, column?: string, vars?: ImportIssue['vars']): void {
    this.list.push({ line, level: 'error', code, ...(column ? { column } : {}), ...(vars ? { vars } : {}) });
    this.bad.add(line);
  }
  warn(line: number, code: IssueCode, column?: string, vars?: ImportIssue['vars']): void {
    this.list.push({ line, level: 'warning', code, ...(column ? { column } : {}), ...(vars ? { vars } : {}) });
  }
  fileErr(code: IssueCode, vars?: ImportIssue['vars']): void {
    this.list.push({ line: null, level: 'error', code, ...(vars ? { vars } : {}) });
  }
  failed(line: number): boolean {
    return this.bad.has(line);
  }
  /** File-level first, then by sheet row; the order within a row is kept. */
  sorted(): ImportIssue[] {
    return this.list.map((x, i) => [x, i] as const)
      .sort((a, b) => (a[0].line ?? -1) - (b[0].line ?? -1) || a[1] - b[1]).map(([x]) => x);
  }
}

function textCell(is: Issues, line: number, v: string, column: string, max: number, required: boolean): string | null {
  const s = v.trim();
  if (!s) {
    if (required) is.err(line, 'required', column);
    return null;
  }
  if (s.length > max) {
    is.err(line, 'too_long', column, { max });
    return null;
  }
  return s;
}

function choice<T extends string>(is: Issues, line: number, v: string, column: string, allowed: readonly T[], fold: boolean): T | null {
  const s = fold ? v.trim().toLowerCase() : v.trim();
  if ((allowed as readonly string[]).includes(s)) return s as T;
  is.err(line, 'invalid_value', column, { value: v.trim(), allowed: allowed.join(', ') });
  return null;
}

function count(actions: { kind: ActionKind }[]): ImportCounts {
  const c: ImportCounts = { create: 0, update: 0, unchanged: 0 };
  for (const a of actions) c[a.kind]++;
  return c;
}

// ---------------------------------------------------------------- users

export const USER_ROLES = ['admin', 'manager'] as const;
export const USER_LANGS = ['en', 'ar'] as const;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 1024;
const USERNAME_MAX = 100;
const NAME_MAX = 200;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export type ExistingUser = {
  id: number; username: string; name: string; email: string | null; role: 'admin' | 'manager'; lang: 'en' | 'ar'; active: boolean;
};
/** Server-side password work already done for this import: a staged hash, or "the file's password is the current one". */
export type StagedPassword = 'hash' | 'same';
export type UserAction = {
  line: number; kind: ActionKind; username: string; id?: number;
  name: string; role: 'admin' | 'manager'; lang: 'en' | 'ar'; email: string | null;
  /** The password is set from the staged hash (new user, or a reset). */
  setPassword: boolean;
  changes: string[];
};
/** Password work still needed before Apply: hash a new password (or generate one), or check one against the current hash. */
export type PasswordOp = { line: number; username: string; op: 'verify' | 'hash' };
export type UsersPlan = ImportCounts & { issues: ImportIssue[]; actions: UserAction[]; pending: PasswordOp[] };

/** Same rule as the user screens (ruling R11): trimmed, lower-case, no whitespace inside. */
export function normalizeImportUsername(v: string): string {
  return v.trim().toLowerCase();
}

export function planUsers(
  rows: UserImportRow[], ctx: { users: ExistingUser[]; actorId: number; staged: Map<string, StagedPassword> },
): UsersPlan {
  const C = IMPORT_COLUMNS.users;
  const is = new Issues();
  const byName = new Map(ctx.users.map((u) => [u.username, u]));
  const seen = new Map<string, number>();
  const actions: UserAction[] = [];
  const pendingAll: PasswordOp[] = [];

  for (const r of rows) {
    const L = r.line;
    let username = textCell(is, L, r.username, C[0], USERNAME_MAX, true);
    if (username !== null) {
      username = normalizeImportUsername(username);
      if (/\s/.test(username)) {
        is.err(L, 'invalid_username', C[0]);
        username = null;
      }
    }
    const name = textCell(is, L, r.name, C[1], NAME_MAX, true);
    const role = r.role.trim() ? choice(is, L, r.role, C[2], USER_ROLES, true) : (is.err(L, 'required', C[2]), null);
    const lang = r.lang.trim() ? choice(is, L, r.lang, C[4], USER_LANGS, true) : null;
    let email: string | null = null;
    if (r.email.trim()) {
      email = textCell(is, L, r.email, C[5], EMAIL_MAX, false);
      if (email !== null && !EMAIL_RE.test(email)) {
        is.err(L, 'invalid_email', C[5]);
        email = null;
      }
    }
    const password = r.password.trim() ? r.password : '';
    if (password && password.length < PASSWORD_MIN) is.err(L, 'password_short', C[3], { min: PASSWORD_MIN });
    if (password.length > PASSWORD_MAX) is.err(L, 'password_long', C[3], { max: PASSWORD_MAX });
    if (username !== null) {
      const first = seen.get(username);
      if (first !== undefined) is.err(L, 'duplicate', C[0], { other: first });
      else seen.set(username, L);
    }
    if (username === null || name === null || role === null) continue;

    const cur = byName.get(username);
    if (cur && cur.id === ctx.actorId && role !== 'admin') is.err(L, 'self_demote', C[2]);
    if (cur && !cur.active) is.warn(L, 'user_disabled', C[0]);
    if (is.failed(L)) continue;

    const staged = ctx.staged.get(username);
    if (!cur) {
      if (staged !== 'hash') pendingAll.push({ line: L, username, op: 'hash' });
      actions.push({ line: L, kind: 'create', username, name, role, lang: lang ?? 'en', email, setPassword: true, changes: [] });
      continue;
    }
    const after = { name, role, lang: lang ?? cur.lang, email: r.email.trim() ? email : cur.email };
    const changes: string[] = (['name', 'role', 'lang', 'email'] as const).filter((k) => after[k] !== cur[k]);
    let setPassword = false;
    if (password) {
      if (staged === undefined) {
        pendingAll.push({ line: L, username, op: 'verify' });
        setPassword = true; // until checked, assume a reset
      } else setPassword = staged === 'hash';
    }
    if (setPassword) changes.push('password');
    actions.push({
      line: L, kind: changes.length ? 'update' : 'unchanged', username, id: cur.id, ...after, setPassword, changes,
    });
  }
  const issues = is.sorted();
  const blocked = issues.some((i) => i.level === 'error');
  return { ...count(actions), issues, actions, pending: blocked ? [] : pendingAll };
}

// ---------------------------------------------------------------- packs

export const PACK_GROUPS = ['CSD', 'Water', 'LRB-Others'] as const;
export type PackGroupName = (typeof PACK_GROUPS)[number];
const PACK_CODE_MAX = 50;
const SORT_MAX = 1_000_000_000;
const YES = new Set(['yes', 'y', 'true', '1', 'نعم']);
const NO = new Set(['no', 'n', 'false', '0', 'لا']);

export type ExistingPack = { code: string; grp: PackGroupName; active: boolean; sort: number };
export type PackAction = {
  line: number; kind: ActionKind; code: string; grp: PackGroupName; sort: number; active: boolean; changes: string[];
};
export type PacksPlan = ImportCounts & { issues: ImportIssue[]; actions: PackAction[] };

export function planPacks(rows: PackImportRow[], ctx: { packs: ExistingPack[] }): PacksPlan {
  const C = IMPORT_COLUMNS.packs;
  const is = new Issues();
  const byCode = new Map(ctx.packs.map((p) => [p.code, p]));
  const byFolded = new Map(ctx.packs.map((p) => [p.code.toLowerCase(), p.code]));
  const seen = new Map<string, number>();
  const actions: PackAction[] = [];
  let nextSort = Math.max(0, ...ctx.packs.map((p) => p.sort)) + 1;

  for (const r of rows) {
    const L = r.line;
    const code = textCell(is, L, r.code, C[0], PACK_CODE_MAX, true);
    const grp = r.grp.trim() ? choice(is, L, r.grp, C[1], PACK_GROUPS, false) : (is.err(L, 'required', C[1]), null);
    let sort: number | null = null;
    if (r.sort.trim()) {
      const s = r.sort.trim();
      if (/^-?\d+$/.test(s) && Math.abs(Number(s)) <= SORT_MAX) sort = Number(s);
      else is.err(L, 'invalid_value', C[2], { value: s, allowed: '0, 1, 2, …' });
    }
    let active: boolean | null = null;
    if (r.active.trim()) {
      const a = r.active.trim().toLowerCase();
      if (YES.has(a)) active = true;
      else if (NO.has(a)) active = false;
      else is.err(L, 'invalid_value', C[3], { value: r.active.trim(), allowed: 'yes, no' });
    }
    if (code !== null) {
      const first = seen.get(code);
      if (first !== undefined) is.err(L, 'duplicate', C[0], { other: first });
      else {
        seen.set(code, L);
        const other = byFolded.get(code.toLowerCase());
        if (!byCode.has(code) && other !== undefined) is.err(L, 'case_mismatch', C[0], { existing: other });
      }
    }
    if (is.failed(L) || code === null || grp === null) continue;

    const cur = byCode.get(code);
    if (!cur) {
      const s = sort ?? nextSort;
      nextSort = Math.max(nextSort, s + 1);
      actions.push({ line: L, kind: 'create', code, grp, sort: s, active: active ?? true, changes: [] });
      continue;
    }
    const after = { grp, sort: sort ?? cur.sort, active: active ?? cur.active };
    const changes = (['grp', 'sort', 'active'] as const).filter((k) => after[k] !== cur[k]);
    actions.push({ line: L, kind: changes.length ? 'update' : 'unchanged', code, ...after, changes });
  }
  return { ...count(actions), issues: is.sorted(), actions };
}

// ---------------------------------------------------------------- hierarchy

/** Levels of new nodes that hang under other new nodes: one INSERT statement per level. */
export const HIERARCHY_MAX_LEVELS = 8;
/**
 * Existing nodes in an open month whose parent changes: each one is carried
 * into the open months on its own (6 D1 queries each, see services/imports.ts).
 */
export const HIERARCHY_MAX_OPEN_MOVES = 4;
const NODE_NAME_MAX = 200;

export type ExistingDept = { id: number; code: string; name: string };
export type ExistingNode = { id: number; dept_id: number; parent_id: number | null; name: string; manager_user_id: number | null };
export type ExistingUserRef = { id: number; username: string; active: boolean };
export type NodeAction = {
  line: number; kind: ActionKind; deptId: number; name: string;
  /** Parent node name; null for the department's root. */
  parent: string | null;
  /** Parent id when the parent already exists; undefined when it is created by this import. */
  parentId?: number | null;
  /** The manager after the import. */
  managerId: number | null;
  /** Existing node id (update / unchanged). */
  id?: number;
  /** New nodes: 0 when the parent exists already (or root), else 1 + the parent's level. */
  level?: number;
  moved: boolean;
  managerChanged: boolean;
  /** The existing node is in a running or loading month (its move must be carried there). */
  openMonth: boolean;
  changes: string[];
};
export type HierarchyPlan = ImportCounts & { issues: ImportIssue[]; actions: NodeAction[]; levels: number };

export function planHierarchy(rows: NodeImportRow[], ctx: {
  departments: ExistingDept[]; nodes: ExistingNode[]; users: ExistingUserRef[];
  /** Live node ids that appear in a running or loading month. */
  openMonthNodeIds?: Set<number>; maxLevels?: number; maxMoves?: number;
}): HierarchyPlan {
  const C = IMPORT_COLUMNS.hierarchy;
  const maxLevels = ctx.maxLevels ?? HIERARCHY_MAX_LEVELS;
  const maxMoves = ctx.maxMoves ?? HIERARCHY_MAX_OPEN_MOVES;
  const is = new Issues();
  const deptByCode = new Map(ctx.departments.map((d) => [d.code.toUpperCase(), d]));
  const deptsByName = new Map<string, ExistingDept[]>();
  for (const d of ctx.departments) deptsByName.set(d.name.toLowerCase(), [...(deptsByName.get(d.name.toLowerCase()) ?? []), d]);
  const userByName = new Map(ctx.users.map((u) => [u.username, u]));
  const key = (dept: number, name: string) => `${dept}\u0000${name}`;
  const existing = new Map(ctx.nodes.map((n) => [key(n.dept_id, n.name), n]));
  const existingFolded = new Map(ctx.nodes.map((n) => [key(n.dept_id, n.name.toLowerCase()), n.name]));
  const rootOf = new Map<number, ExistingNode>();
  for (const n of ctx.nodes) if (n.parent_id === null) rootOf.set(n.dept_id, n);

  // Pass 1: each row on its own.
  type Row = { line: number; deptId: number; name: string; parent: string | null; managerId: number | null | undefined };
  const good: Row[] = [];
  const fileNodes = new Map<string, number>(); // key -> line (every row with a usable department + name)
  const newRootLine = new Map<number, number>();
  for (const r of rows) {
    const L = r.line;
    const deptText = textCell(is, L, r.dept, C[0], NODE_NAME_MAX, true);
    let dept: ExistingDept | undefined;
    if (deptText !== null) {
      dept = deptByCode.get(deptText.toUpperCase());
      if (!dept) {
        const byName = deptsByName.get(deptText.toLowerCase()) ?? [];
        if (byName.length === 1) dept = byName[0];
      }
      if (!dept) is.err(L, 'unknown_department', C[0], { value: deptText });
    }
    const name = textCell(is, L, r.node, C[1], NODE_NAME_MAX, true);
    const parent = textCell(is, L, r.parent, C[2], NODE_NAME_MAX, false);
    let managerId: number | null | undefined; // undefined: blank (keep / none)
    const mgrText = r.manager.trim();
    if (mgrText) {
      const u = userByName.get(normalizeImportUsername(mgrText));
      if (!u) is.err(L, 'unknown_manager', C[3], { value: mgrText });
      else if (!u.active) is.err(L, 'manager_disabled', C[3], { value: mgrText });
      else managerId = u.id;
    }
    if (!dept || name === null) continue;
    const k = key(dept.id, name);
    const first = fileNodes.get(k);
    if (first !== undefined) {
      is.err(L, 'duplicate', C[1], { other: first });
      continue;
    }
    fileNodes.set(k, L);
    const cur = existing.get(k);
    if (!cur) {
      const other = existingFolded.get(key(dept.id, name.toLowerCase()));
      if (other !== undefined) is.err(L, 'case_mismatch', C[1], { existing: other });
    }
    if (parent !== null && parent === name) is.err(L, 'parent_self', C[2]);
    const root = rootOf.get(dept.id);
    if (cur && cur.parent_id === null && parent !== null) is.err(L, 'root_parent', C[2]);
    if (parent === null && !(cur && cur.parent_id === null)) {
      if (root) is.err(L, 'root_exists', C[2], { root: root.name });
      else if (newRootLine.has(dept.id)) is.err(L, 'two_roots', C[2], { other: newRootLine.get(dept.id)! });
      else newRootLine.set(dept.id, L);
    }
    if (!cur && managerId === undefined && !is.failed(L)) is.warn(L, 'no_manager', C[3]);
    good.push({ line: L, deptId: dept.id, name, parent, managerId });
  }

  // Pass 2: parents exist (in the file or the live tree of the same department).
  for (const g of good) {
    if (g.parent === null || g.parent === g.name || is.failed(g.line)) continue;
    if (!fileNodes.has(key(g.deptId, g.parent)) && !existing.has(key(g.deptId, g.parent))) {
      is.err(g.line, 'unknown_parent', C[2], { value: g.parent });
    }
  }

  // Pass 3: the tree after the import has no cycle. Live parents, overridden by the valid rows.
  const ok = good.filter((g) => !is.failed(g.line));
  const parentOf = new Map<string, string | null>();
  const nameOfId = new Map(ctx.nodes.map((n) => [n.id, n.name]));
  for (const n of ctx.nodes) parentOf.set(key(n.dept_id, n.name), n.parent_id === null ? null : key(n.dept_id, nameOfId.get(n.parent_id) ?? ''));
  for (const g of ok) parentOf.set(key(g.deptId, g.name), g.parent === null ? null : key(g.deptId, g.parent));
  const label = (k: string) => k.slice(k.indexOf('\u0000') + 1);
  const inCycle = new Set<string>();
  for (const g of ok) {
    const start = key(g.deptId, g.name);
    const path = [start];
    const seenK = new Set([start]);
    let cur = parentOf.get(start) ?? null;
    while (cur !== null && !seenK.has(cur)) {
      seenK.add(cur);
      path.push(cur);
      cur = parentOf.get(cur) ?? null;
    }
    if (cur === start) {
      is.err(g.line, 'cycle', C[2], { path: [...path, start].map(label).join(' → ') });
      inCycle.add(start);
    }
  }

  // Pass 4: actions, levels of new nodes, moves into open months.
  const valid = good.filter((g) => !is.failed(g.line));
  const newLevel = new Map<string, number>();
  const levelOf = (k: string, depth = 0): number => {
    const known = newLevel.get(k);
    if (known !== undefined) return known;
    const p = parentOf.get(k) ?? null;
    const lvl = p === null || existing.has(p) || depth > rows.length ? 0 : levelOf(p, depth + 1) + 1;
    newLevel.set(k, lvl);
    return lvl;
  };
  const actions: NodeAction[] = [];
  let levels = 0;
  let openMoves = 0;
  for (const g of valid) {
    const k = key(g.deptId, g.name);
    const cur = existing.get(k);
    const parentNode = g.parent === null ? null : existing.get(key(g.deptId, g.parent));
    const parentId = g.parent === null ? null : parentNode ? parentNode.id : undefined;
    if (!cur) {
      const level = levelOf(k);
      if (level >= maxLevels) {
        is.err(g.line, 'too_deep', C[2], { max: maxLevels });
        continue;
      }
      levels = Math.max(levels, level + 1);
      actions.push({
        line: g.line, kind: 'create', deptId: g.deptId, name: g.name, parent: g.parent, parentId,
        managerId: g.managerId ?? null, level, moved: false, managerChanged: false, openMonth: false, changes: [],
      });
      continue;
    }
    const moved = cur.parent_id !== null && g.parent !== null && (parentId === undefined || parentId !== cur.parent_id);
    const managerId = g.managerId === undefined ? cur.manager_user_id : g.managerId;
    const managerChanged = managerId !== cur.manager_user_id;
    const changes = [...(moved ? ['parent'] : []), ...(managerChanged ? ['manager'] : [])];
    const openMonth = ctx.openMonthNodeIds?.has(cur.id) ?? false;
    if (moved && openMonth) openMoves++;
    actions.push({
      line: g.line, kind: changes.length ? 'update' : 'unchanged', deptId: g.deptId, name: g.name, parent: g.parent,
      parentId: g.parent === null ? null : parentId, managerId, id: cur.id, moved, managerChanged, openMonth, changes,
    });
  }
  if (openMoves > maxMoves) is.fileErr('too_many_moves', { n: openMoves, max: maxMoves });
  return { ...count(actions), issues: is.sorted(), actions, levels };
}

/** True when the plan has at least one error (Apply is refused). */
export const hasErrors = (issues: ImportIssue[]): boolean => issues.some((i) => i.level === 'error');
