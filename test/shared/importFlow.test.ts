import { describe, expect, it } from 'vitest';
import { readSheet } from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { ISSUE_CODES, parseImportSheet } from '../../src/shared/imports';
import { ar } from '../../src/web/i18n/ar';
import { en } from '../../src/web/i18n/en';
import { isolate, stagePasswords, templateFor } from '../../src/web/importFlow';
import { toCells } from '../../src/web/excel';

describe('templateFor', () => {
  it('has the exact headers and one example row that reads back through the import parser', async () => {
    for (const kind of ['users', 'packs', 'hierarchy'] as const) {
      const tpl = templateFor(kind, kind === 'hierarchy' ? { dept: 'TT', parent: 'Head' } : {});
      const buf = await writeXlsxFile([tpl.columns.map((value) => ({ value })), ...toCells(tpl.rows, tpl.kinds)] as never).toBuffer();
      const parsed = parseImportSheet(kind, await readSheet(buf));
      expect(parsed.ok, kind).toBe(true);
      if (parsed.ok) expect(parsed.rows).toHaveLength(1);
    }
    expect(templateFor('packs', {}).columns).toEqual(['Code', 'Group', 'Sort order', 'Active']);
    expect(templateFor('hierarchy', { dept: 'MT', parent: 'MT Head' }).rows[0]!.slice(0, 3)).toEqual(['MT', 'Example team', 'MT Head']);
    expect(templateFor('users', {}).fileName).toBe('users-import-template.xlsx');
  });
});

describe('stagePasswords', () => {
  it('runs one request per password: verify first for existing users (hash only if different), collects generated ones', async () => {
    const calls: unknown[] = [];
    const answers: Record<string, unknown> = {
      'verify:ali': { same: false }, 'hash:ali': { ok: true }, 'verify:sara': { same: true },
      'hash:new1': { ok: true, generated: 'Gen12345abcd' }, 'hash:new2': { ok: true },
    };
    const progress: [number, number][] = [];
    const generated = await stagePasswords(
      'imp-123456',
      [{ line: 2, username: 'ali', op: 'verify' }, { line: 3, username: 'sara', op: 'verify' }, { line: 4, username: 'new1', op: 'hash' }, { line: 5, username: 'new2', op: 'hash' }],
      new Map([[2, 'pw-ali-123'], [3, 'pw-sara-123'], [4, ''], [5, 'pw-new2-123']]),
      async (body) => {
        calls.push(body);
        return answers[`${body.op}:${body.username}`] as never;
      },
      (done, total) => progress.push([done, total]),
    );
    expect(generated).toEqual([{ username: 'new1', password: 'Gen12345abcd' }]);
    expect(calls).toEqual([
      { importId: 'imp-123456', username: 'ali', password: 'pw-ali-123', op: 'verify' },
      { importId: 'imp-123456', username: 'ali', password: 'pw-ali-123', op: 'hash' },
      { importId: 'imp-123456', username: 'sara', password: 'pw-sara-123', op: 'verify' },
      { importId: 'imp-123456', username: 'new1', password: '', op: 'hash' },
      { importId: 'imp-123456', username: 'new2', password: 'pw-new2-123', op: 'hash' },
    ]);
    expect(progress).toEqual([[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]);
  });
});

describe('isolate', () => {
  it('wraps every value in Unicode isolates so Latin names keep their order inside Arabic sentences', () => {
    expect(isolate({ column: 'Node name', n: 3 })).toEqual({ column: '⁨Node name⁩', n: '⁨3⁩' });
  });
});

describe('issue texts', () => {
  it('every issue code has an English and an Arabic sentence with the same placeholders', () => {
    for (const code of ISSUE_CODES) {
      const key = `imIssue_${code}` as keyof typeof en;
      expect(en[key], code).toBeTypeOf('string');
      const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(holes(ar[key]), code).toEqual(holes(en[key]));
    }
  });
});
