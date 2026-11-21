import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findDatabaseId, parseDatabaseList, patchDatabaseId } from '../../scripts/deploy-ci.mjs';

const ZERO = '00000000-0000-0000-0000-000000000000';
const REAL = '11111111-2222-3333-4444-555555555555';

describe('patchDatabaseId', () => {
  it('replaces the zero UUID of the target-portal binding and keeps other keys', () => {
    const text = readFileSync('wrangler.jsonc', 'utf8');
    const before = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
    const out = patchDatabaseId(text, REAL);
    const after = JSON.parse(out);
    expect(after.d1_databases[0].database_id).toBe(REAL);
    expect(out).not.toContain(ZERO);
    after.d1_databases[0].database_id = ZERO;
    expect(after).toEqual(before);
  });

  it('only touches the binding named target-portal', () => {
    const text = JSON.stringify({
      name: 'x',
      d1_databases: [
        { binding: 'OTHER', database_name: 'other', database_id: 'keep-me' },
        { binding: 'DB', database_name: 'target-portal', database_id: ZERO },
      ],
    });
    const after = JSON.parse(patchDatabaseId(text, REAL));
    expect(after.d1_databases[0].database_id).toBe('keep-me');
    expect(after.d1_databases[1].database_id).toBe(REAL);
  });

  it('accepts JSONC comments and trailing commas, including // inside strings', () => {
    const text = `{
      // comment
      "name": "a//b", /* block */
      "d1_databases": [
        { "binding": "DB", "database_name": "target-portal", "database_id": "${ZERO}", },
      ],
    }`;
    const after = JSON.parse(patchDatabaseId(text, REAL));
    expect(after.name).toBe('a//b');
    expect(after.d1_databases[0].database_id).toBe(REAL);
  });

  it('throws when there is no target-portal binding', () => {
    const text = JSON.stringify({ d1_databases: [{ binding: 'DB', database_name: 'other', database_id: ZERO }] });
    expect(() => patchDatabaseId(text, REAL)).toThrow(/target-portal/);
    expect(() => patchDatabaseId('{}', REAL)).toThrow(/target-portal/);
  });
});

describe('parseDatabaseList / findDatabaseId', () => {
  const json = JSON.stringify([{ uuid: REAL, name: 'target-portal' }, { uuid: 'x', name: 'other' }]);

  it('parses plain JSON and JSON preceded by a banner', () => {
    expect(findDatabaseId(parseDatabaseList(json))).toBe(REAL);
    expect(findDatabaseId(parseDatabaseList(` ⛅️ wrangler 4.151.2 [x]\n${json}\n`))).toBe(REAL);
  });

  it('returns undefined / empty on unusable output', () => {
    expect(findDatabaseId(parseDatabaseList('not json'))).toBeUndefined();
    expect(findDatabaseId(parseDatabaseList('[]'))).toBeUndefined();
  });
});
