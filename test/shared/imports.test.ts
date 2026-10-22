import { describe, expect, it } from 'vitest';
import {
  coerceImportRows, IMPORT_COLUMNS, IMPORT_MAX_ROWS, parseImportSheet, planHierarchy, planPacks, planUsers,
  type ExistingNode, type ImportIssue, type NodeImportRow, type PackImportRow, type UserImportRow,
} from '../../src/shared/imports';

const codes = (issues: ImportIssue[]) => issues.map((i) => `${i.line}:${i.level}:${i.code}`);

describe('parseImportSheet', () => {
  it('finds the header below a title row (case, spaces and aliases ignored), trims cells, skips blank rows', () => {
    const r = parseImportSheet('users', [
      ['Users export'],
      [' USER name', 'name', 'Role', 'Password', 'Lang', 'E-mail'],
      ['  Ali ', 'Ali Hassan', 'Manager', 12345678, null, undefined],
      [null, '', null],
      ['sara', 'Sara', 'admin', '', 'ar', 'sara@example.com'],
    ]);
    expect(r).toEqual({
      ok: true,
      rows: [
        { line: 3, username: 'Ali', name: 'Ali Hassan', role: 'Manager', password: '12345678', lang: '', email: '' },
        { line: 5, username: 'sara', name: 'Sara', role: 'admin', password: '', lang: 'ar', email: 'sara@example.com' },
      ],
    });
  });

  it('optional columns may be missing; numbers and booleans become text', () => {
    const r = parseImportSheet('packs', [['Code', 'Group'], ['CSD_X', 'CSD'], [330, 'Water']]);
    expect(r).toEqual({ ok: true, rows: [
      { line: 2, code: 'CSD_X', grp: 'CSD', sort: '', active: '' },
      { line: 3, code: '330', grp: 'Water', sort: '', active: '' },
    ] });
    const h = parseImportSheet('hierarchy', [[...IMPORT_COLUMNS.hierarchy], ['TT', 'Head', null, 'boss', true]]);
    expect(h).toEqual({ ok: true, rows: [{ line: 2, dept: 'TT', node: 'Head', parent: '', manager: 'boss' }] });
  });

  it('reports the missing required columns, an empty file and too many rows', () => {
    expect(parseImportSheet('hierarchy', [['Department', 'Node name']])).toEqual({ ok: false, reason: 'no_header', missing: ['Parent node name'] });
    expect(parseImportSheet('packs', [['x']])).toEqual({ ok: false, reason: 'no_header', missing: ['Code', 'Group'] });
    expect(parseImportSheet('packs', [['Code', 'Group'], [null, null]])).toEqual({ ok: false, reason: 'no_rows' });
    const many = [['Code', 'Group'], ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => [`P${i}`, 'CSD'])];
    expect(parseImportSheet('packs', many)).toEqual({ ok: false, reason: 'too_many', count: IMPORT_MAX_ROWS + 1 });
  });
});

describe('coerceImportRows (server side: never trusts the client)', () => {
  it('fills absent fields with "" and keeps lines', () => {
    expect(coerceImportRows('packs', [{ line: 4, code: 'A' }])).toEqual({ ok: true, rows: [{ line: 4, code: 'A', grp: '', sort: '', active: '' }] });
  });
  it('rejects non-arrays, non-objects, non-string fields, bad lines and over-long cells', () => {
    expect(coerceImportRows('packs', 'x').ok).toBe(false);
    expect(coerceImportRows('packs', []).ok).toBe(false);
    expect(coerceImportRows('packs', [7]).ok).toBe(false);
    expect(coerceImportRows('packs', [{ line: 2, code: 5 }]).ok).toBe(false);
    expect(coerceImportRows('packs', [{ line: 0, code: 'A' }]).ok).toBe(false);
    expect(coerceImportRows('packs', [{ line: 2, code: 'x'.repeat(1025) }]).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- users

const U = (line: number, username: string, over: Partial<UserImportRow> = {}): UserImportRow =>
  ({ line, username, name: `Name ${username}`, role: 'manager', password: '', lang: '', email: '', ...over });

const existingUsers = [
  { id: 1, username: 'boss', name: 'Boss', email: null, role: 'admin' as const, lang: 'en' as const, active: true },
  { id: 2, username: 'ali', name: 'Name ali', email: 'ali@x.com', role: 'manager' as const, lang: 'ar' as const, active: true },
  { id: 3, username: 'old', name: 'Name old', email: null, role: 'manager' as const, lang: 'en' as const, active: false },
];

describe('planUsers', () => {
  it('creates, updates and leaves unchanged; blank language/email keep the current value', () => {
    const p = planUsers([
      U(2, 'New.One', { lang: 'AR', email: 'n@x.com' }),
      U(3, 'ali'),
      U(4, 'boss', { name: 'Big Boss', role: 'Admin' }),
    ], { users: existingUsers, actorId: 1, staged: new Map([['new.one', 'hash']]) });
    expect(p.issues).toEqual([]);
    expect([p.create, p.update, p.unchanged]).toEqual([1, 1, 1]);
    expect(p.actions.map((a) => [a.username, a.kind, a.changes])).toEqual([
      ['new.one', 'create', []], ['ali', 'unchanged', []], ['boss', 'update', ['name']],
    ]);
    expect(p.actions[0]).toMatchObject({ lang: 'ar', email: 'n@x.com', role: 'manager', setPassword: true });
    expect(p.actions[1]).toMatchObject({ lang: 'ar', email: 'ali@x.com' });
    expect(p.pending).toEqual([]);
  });

  it('lists the password work still to do: new users need a hash, existing ones with a password need a check', () => {
    const rows = [U(2, 'n1'), U(3, 'n2', { password: 'secret-123' }), U(4, 'ali', { password: 'secret-456' }), U(5, 'boss', { name: 'Boss', role: 'admin' })];
    const p = planUsers(rows, { users: existingUsers, actorId: 1, staged: new Map() });
    expect(p.pending).toEqual([{ line: 2, username: 'n1', op: 'hash' }, { line: 3, username: 'n2', op: 'hash' }, { line: 4, username: 'ali', op: 'verify' }]);
    // Once staged: a verified-same password is no change; a staged hash is a reset.
    const same = planUsers(rows, { users: existingUsers, actorId: 1, staged: new Map([['n1', 'hash'], ['n2', 'hash'], ['ali', 'same']]) });
    expect(same.pending).toEqual([]);
    expect(same.actions.find((a) => a.username === 'ali')).toMatchObject({ kind: 'unchanged', setPassword: false });
    const reset = planUsers(rows, { users: existingUsers, actorId: 1, staged: new Map([['n1', 'hash'], ['n2', 'hash'], ['ali', 'hash']]) });
    expect(reset.actions.find((a) => a.username === 'ali')).toMatchObject({ kind: 'update', setPassword: true, changes: ['password'] });
    expect([reset.create, reset.update, reset.unchanged]).toEqual([2, 1, 1]);
  });

  it('a staged hash for an existing user without a password in the file is ignored', () => {
    const p = planUsers([U(2, 'ali')], { users: existingUsers, actorId: 1, staged: new Map([['ali', 'hash']]) });
    expect(p.actions[0]).toMatchObject({ kind: 'unchanged', setPassword: false });
  });

  it('validates every field and reports each problem with its line', () => {
    const p = planUsers([
      U(2, '', { name: '' }),
      U(3, 'has space', { role: 'boss' }),
      U(4, 'x', { lang: 'fr', email: 'nope' }),
      U(5, 'y', { password: 'short' }),
      U(6, 'X'),
      U(7, 'z'.repeat(101)),
    ], { users: existingUsers, actorId: 1, staged: new Map() });
    expect(codes(p.issues)).toEqual([
      '2:error:required', '2:error:required',
      '3:error:invalid_username', '3:error:invalid_value',
      '4:error:invalid_value', '4:error:invalid_email',
      '5:error:password_short',
      '6:error:duplicate',
      '7:error:too_long',
    ]);
    expect(p.issues[0]).toMatchObject({ column: 'Username' });
    expect(p.issues[3]).toMatchObject({ column: 'Role', vars: { value: 'boss', allowed: 'admin, manager' } });
    expect(p.issues[7]).toMatchObject({ vars: { other: 4 } });
    expect(p.pending).toEqual([]); // nothing to hash while the file has errors
  });

  it('the admin cannot demote themself; a disabled user is updated but stays disabled (warning)', () => {
    const p = planUsers([U(2, 'boss', { role: 'manager' }), U(3, 'old', { name: 'Renamed' })], { users: existingUsers, actorId: 1, staged: new Map() });
    expect(codes(p.issues)).toEqual(['2:error:self_demote', '3:warning:user_disabled']);
    expect(p.actions.find((a) => a.username === 'old')).toMatchObject({ kind: 'update', changes: ['name'] });
  });
});

// ---------------------------------------------------------------- packs

const P = (line: number, code: string, grp: string, sort = '', active = ''): PackImportRow => ({ line, code, grp, sort, active });
const existingPacks = [{ code: 'CSD_PET', grp: 'CSD' as const, active: true, sort: 5 }, { code: 'AQ_500', grp: 'Water' as const, active: false, sort: 9 }];

describe('planPacks', () => {
  it('creates (blank sort = next number, blank active = yes), updates and leaves unchanged', () => {
    const p = planPacks([
      P(2, 'NEW_A', 'LRB-Others'), P(3, 'NEW_B', 'CSD', '', 'no'),
      P(4, 'CSD_PET', 'CSD', '5', 'Yes'), P(5, 'AQ_500', 'Water', '', 'TRUE'),
    ], { packs: existingPacks });
    expect(p.issues).toEqual([]);
    expect(p.actions.map((a) => [a.code, a.kind, a.grp, a.sort, a.active, a.changes])).toEqual([
      ['NEW_A', 'create', 'LRB-Others', 10, true, []],
      ['NEW_B', 'create', 'CSD', 11, false, []],
      ['CSD_PET', 'unchanged', 'CSD', 5, true, []],
      ['AQ_500', 'update', 'Water', 9, true, ['active']],
    ]);
    expect([p.create, p.update, p.unchanged]).toEqual([2, 1, 1]);
  });

  it('accepts the group only exactly as CSD, Water or LRB-Others', () => {
    const p = planPacks([P(2, 'A', 'csd'), P(3, 'B', 'LRB'), P(4, 'C', ''), P(5, 'D', 'Water', '1.5', 'maybe')], { packs: existingPacks });
    expect(codes(p.issues)).toEqual(['2:error:invalid_value', '3:error:invalid_value', '4:error:required', '5:error:invalid_value', '5:error:invalid_value']);
    expect(p.issues[0]).toMatchObject({ column: 'Group', vars: { value: 'csd', allowed: 'CSD, Water, LRB-Others' } });
  });

  it('refuses duplicates and a code that differs from an existing one only by letter case', () => {
    const p = planPacks([P(2, 'X', 'CSD'), P(3, 'X', 'Water'), P(4, 'csd_pet', 'CSD')], { packs: existingPacks });
    expect(codes(p.issues)).toEqual(['3:error:duplicate', '4:error:case_mismatch']);
    expect(p.issues[1]).toMatchObject({ vars: { existing: 'CSD_PET' } });
  });
});

// ---------------------------------------------------------------- hierarchy

const N = (line: number, node: string, parent = '', manager = '', dept = 'TT'): NodeImportRow => ({ line, dept, node, parent, manager });
const departments = [{ id: 10, code: 'TT', name: 'Traditional Trade' }, { id: 20, code: 'MT', name: 'Modern Trade' }];
const hUsers = [{ id: 1, username: 'boss', active: true }, { id: 2, username: 'ali', active: true }, { id: 3, username: 'old', active: false }];
const tree: ExistingNode[] = [
  { id: 100, dept_id: 10, parent_id: null, name: 'Head', manager_user_id: 1 },
  { id: 101, dept_id: 10, parent_id: 100, name: 'Area', manager_user_id: 2 },
  { id: 102, dept_id: 10, parent_id: 101, name: 'Sup A', manager_user_id: null },
];
const ctx = (over: Partial<Parameters<typeof planHierarchy>[1]> = {}) =>
  ({ departments, nodes: tree, users: hUsers, ...over });

describe('planHierarchy', () => {
  it('builds a new department tree from rows in any order: parents get a lower level than their children', () => {
    const p = planHierarchy([
      N(2, 'Sup 1', 'Area 1', 'ali', 'mt'), N(3, 'Area 1', 'MT Head', 'Ali', 'Modern Trade'), N(4, 'MT Head', '', 'boss', 'MT'),
    ], ctx());
    expect(p.issues).toEqual([]);
    expect(p.actions.map((a) => [a.name, a.kind, a.deptId, a.level, a.parent, a.managerId])).toEqual([
      ['Sup 1', 'create', 20, 2, 'Area 1', 2], ['Area 1', 'create', 20, 1, 'MT Head', 2], ['MT Head', 'create', 20, 0, null, 1],
    ]);
    expect(p.levels).toBe(3);
    expect([p.create, p.update, p.unchanged]).toEqual([3, 0, 0]);
  });

  it('matches existing nodes by department + name: moves, manager changes, unchanged; blank manager keeps it', () => {
    const p = planHierarchy([
      N(2, 'Head', '', 'boss'), N(3, 'Area', 'Head', 'boss'), N(4, 'Sup A', 'Head'), N(5, 'Sup B', 'Sup A'),
    ], ctx());
    expect(p.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(p.actions.map((a) => [a.name, a.kind, a.changes, a.moved, a.managerChanged])).toEqual([
      ['Head', 'unchanged', [], false, false],
      ['Area', 'update', ['manager'], false, true],
      ['Sup A', 'update', ['parent'], true, false],
      ['Sup B', 'create', [], false, false],
    ]);
    expect(p.actions[2]).toMatchObject({ id: 102, parentId: 100 });
    expect(p.actions[3]).toMatchObject({ level: 0, parentId: 102 }); // level 0: its parent already exists
  });

  it('re-applying a file identical to the tree changes nothing', () => {
    const p = planHierarchy([N(2, 'Head', '', 'boss'), N(3, 'Area', 'Head', 'ali'), N(4, 'Sup A', 'Area')], ctx());
    expect([p.create, p.update, p.unchanged]).toEqual([0, 0, 3]);
  });

  it('reports unknown departments, managers and parents, disabled managers, duplicates and self-parents', () => {
    const p = planHierarchy([
      N(2, 'X', 'Head', '', 'KA'), N(3, 'Y', 'Head', 'nobody'), N(4, 'Z', 'Head', 'old'),
      N(5, 'W', 'Ghost'), N(6, 'W', 'Head'), N(7, 'V', 'V'), N(8, '', 'Head'),
    ], ctx());
    expect(codes(p.issues.filter((i) => i.level === 'error'))).toEqual([
      '2:error:unknown_department', '3:error:unknown_manager', '4:error:manager_disabled',
      '5:error:unknown_parent', '6:error:duplicate', '7:error:parent_self', '8:error:required',
    ]);
  });

  it('reports every problem of a row: an unknown manager does not hide an unknown parent', () => {
    expect(codes(planHierarchy([N(2, 'Sup B', 'Ghost', 'nobody')], ctx()).issues)).toEqual(['2:error:unknown_manager', '2:error:unknown_parent']);
  });

  it('a node name that differs from an existing one only by letter case is refused', () => {
    const p = planHierarchy([N(2, 'sup a', 'Area')], ctx());
    expect(codes(p.issues)).toEqual(['2:error:case_mismatch']);
  });

  it('detects cycles among the rows and through existing nodes', () => {
    const p = planHierarchy([N(2, 'A', 'B', 'ali', 'MT'), N(3, 'B', 'C', 'ali', 'MT'), N(4, 'C', 'A', 'ali', 'MT')], ctx());
    expect(codes(p.issues)).toEqual(['2:error:cycle', '3:error:cycle', '4:error:cycle']);
    expect(p.issues[0]!.vars!.path).toBe('A → B → C → A');
    // Area under Sup A (its own child) closes a loop through the live tree.
    const q = planHierarchy([N(2, 'Area', 'Sup A')], ctx());
    expect(codes(q.issues)).toEqual(['2:error:cycle']);
  });

  it('one root per department: the root cannot be replaced or moved by an import', () => {
    expect(codes(planHierarchy([N(2, 'Other', '', 'ali')], ctx()).issues)).toEqual(['2:error:root_exists']);
    expect(codes(planHierarchy([N(2, 'Area', '')], ctx()).issues)).toEqual(['2:error:root_exists']);
    expect(codes(planHierarchy([N(2, 'Head', 'Area')], ctx()).issues)).toEqual(['2:error:root_parent']);
    expect(codes(planHierarchy([N(2, 'R1', '', 'ali', 'MT'), N(3, 'R2', '', 'ali', 'MT')], ctx()).issues)).toEqual(['3:error:two_roots']);
  });

  it('warns about new nodes without a manager', () => {
    const p = planHierarchy([N(2, 'Sup B', 'Area')], ctx());
    expect(codes(p.issues)).toEqual(['2:warning:no_manager']);
  });

  it('limits the depth of new-node chains and the moves of nodes that are in open months', () => {
    const chain = Array.from({ length: 4 }, (_, i) => N(i + 2, `L${i}`, i === 0 ? '' : `L${i - 1}`, 'ali', 'MT'));
    expect(codes(planHierarchy(chain, ctx({ maxLevels: 3 })).issues)).toEqual(['5:error:too_deep']);
    const moves = [N(2, 'Area', 'Head'), N(3, 'Sup A', 'Head')];
    const open = new Set([102]);
    expect(planHierarchy(moves, ctx({ openMonthNodeIds: open, maxMoves: 1 })).issues).toEqual([]);
    const many = planHierarchy([N(2, 'Sup A', 'Head'), N(3, 'Area', 'Sup Q'), N(4, 'Sup Q', 'Head', 'ali')], ctx({ openMonthNodeIds: new Set([101, 102]), maxMoves: 1 }));
    expect(many.issues).toEqual([{ line: null, level: 'error', code: 'too_many_moves', vars: { n: 2, max: 1 } }]);
  });
});
