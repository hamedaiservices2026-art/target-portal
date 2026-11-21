import { describe, expect, it } from 'vitest';
import { readSheet } from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { toCells } from '../../src/web/excel';

describe('toCells (export cell types)', () => {
  it('writes code columns as text and Cases as a number: a leading-zero route reads back as "0314"', async () => {
    const kinds = ['string', 'string', 'string', 'string', 'string', 'number'] as const;
    const cells = toCells([['2026-10', 'Presell – TT', '0314', '042059', 'CSD_NRB', 12]], [...kinds]);
    expect(cells[0]!.map((c) => c.type)).toEqual([String, String, String, String, String, Number]);
    const buf = await writeXlsxFile(cells as never).toBuffer();
    const [row] = await readSheet(buf);
    expect(row).toEqual(['2026-10', 'Presell – TT', '0314', '042059', 'CSD_NRB', 12]);
  });

  it('without kinds leaves the value as it is', () => {
    expect(toCells([['a', 1]])).toEqual([[{ value: 'a' }, { value: 1 }]]);
  });
});
