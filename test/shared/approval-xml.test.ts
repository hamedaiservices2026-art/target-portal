import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import write from 'write-excel-file/node';
import { approvalSheets, orderSheetXml, PRINT_FEATURE } from '../../src/web/cycle/approval';

// Excel empties a sheet whose top-level elements are out of the required
// order (LibreOffice does not), so the print setup must come after every
// conditional format.
const ORDER = ['sheetPr', 'sheetViews', 'cols', 'sheetData', 'mergeCells', 'conditionalFormatting', 'printOptions', 'pageMargins', 'pageSetup'];

function tops(xml: string): string[] {
  const inner = xml.slice(xml.indexOf('>', xml.indexOf('<worksheet')) + 1, xml.lastIndexOf('</worksheet>'));
  const out: string[] = [];
  let depth = 0;
  for (const m of inner.matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
    if (depth === 0 && !m[1]) out.push(m[2]!);
    if (m[1]) depth--; else if (!m[3]) depth++;
  }
  return out;
}

describe('approval workbook xml', () => {
  it('orders the added print elements after the conditional formats', () => {
    const xml = '<?xml version="1.0"?><worksheet a="1"><sheetViews/><sheetData><row r="1"><c r="A1"><f>C1&gt;0</f></c></row></sheetData><conditionalFormatting sqref="E7"><cfRule type="cellIs"><formula>0</formula></cfRule></conditionalFormatting><conditionalFormatting sqref="G7"/></worksheet>';
    const out = orderSheetXml(xml, ['<sheetPr/>', '<pageSetup paperSize="9"/>']);
    expect(tops(out)).toEqual(['sheetPr', 'sheetViews', 'sheetData', 'conditionalFormatting', 'conditionalFormatting', 'pageSetup']);
    expect(out).toContain('<f>C1&gt;0</f>');
  });

  it('writes both sheets with their data and elements in the required order', async () => {
    const g = (v: number) => ({ CSD_CANS150: v, AquafinA_330: v / 2 });
    const inp = {
      period: '2026-11',
      layout: [{ p: 'CSD_CANS150' }, { t: 'Total CSD', of: ['CSD_CANS150'] }, { p: 'AquafinA_330' }, { t: 'Total Water', of: ['AquafinA_330'] }, { t: 'Total LRB', of: ['CSD_CANS150', 'AquafinA_330'] }],
      catOf: (p: string) => (p.startsWith('CSD') ? 'CSD' : 'Water'),
      target: g(100), yago: g(90), pago: g(95), plan: g(110),
      heads: [{ name: 'TT', chans: [{ label: 'TT DMM', g: g(60) }, { label: 'TT Outer', g: g(40) }] }],
    };
    const buf = await (write as unknown as (d: unknown, o: unknown) => { toBuffer: () => Promise<Buffer> })(approvalSheets(inp as never), { features: [PRINT_FEATURE] }).toBuffer();
    const files = unzipSync(new Uint8Array(buf));
    for (const n of [1, 2]) {
      const xml = strFromU8(files[`xl/worksheets/sheet${n}.xml`]!);
      const t = tops(xml);
      const ranks = t.map((x) => ORDER.indexOf(x));
      expect(ranks.every((r) => r >= 0), t.join(',')).toBe(true);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
      expect(t).toContain('pageSetup');
    }
    expect(strFromU8(files['xl/workbook.xml']!)).toContain('fullCalcOnLoad="1"');
    const s1 = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(s1).toContain('<v>100</v>');
    expect(tops(s1).filter((x) => x === 'conditionalFormatting').length).toBeGreaterThan(0);
  });
});
