import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { fillApprovalTemplate } from '../../src/web/cycle/approvalTemplate';

// A small template like the admin's: sheet 1 with packs, Totals and a Pack Mix; "By Manager" with channels.
const shared = ['Pack', 'TARGET', 'YAGO ', 'PAGO ', 'PLAN', 'CSD_CANS150', 'CSD_SSPET500/400', 'Total CSD', 'Old Pack', 'SOM', 'CANs', 'TT DMM', 'MT', 'November 2026 Target'];
const si = (i: number) => `t="s"><v>${i}</v>`;
const sheet1 = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`
  + `<row r="6"><c r="B6" s="4" ${si(0)}</c><c r="C6" ${si(1)}</c><c r="D6" ${si(2)}</c><c r="F6" ${si(3)}</c><c r="H6" ${si(4)}</c></row>`
  + `<row r="7"><c r="B7" ${si(5)}</c><c r="C7" s="8"><v>45000</v></c><c r="D7" s="8"><v>1</v></c><c r="E7" s="9"><f>IFERROR(C7/D7-1,0)</f><v>0.5</v></c><c r="F7" s="8"/><c r="H7" s="8"><v>9</v></c></row>`
  + `<row r="8"><c r="B8" ${si(6)}</c><c r="C8" s="8"><v>7</v></c></row>`
  + `<row r="9"><c r="B9" ${si(8)}</c><c r="C9" s="8"><v>5</v></c></row>`
  + `<row r="10"><c r="B10" ${si(7)}</c><c r="C10" s="12"><f>SUM(C7:C9)</f><v>45012</v></c></row>`
  + `<row r="12"><c r="B12" ${si(9)}</c></row><row r="13"><c r="B13" ${si(10)}</c><c r="C13"><f>IFERROR(C7/C10,0)</f><v>1</v></c></row>`
  + `</sheetData></worksheet>`;
const sheet2 = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`
  + `<row r="3"><c r="B3" s="84"><v>46327</v></c></row>`
  + `<row r="4"><c r="B4" ${si(0)}</c><c r="C4" ${si(11)}</c><c r="D4" ${si(12)}</c></row>`
  + `<row r="5"><c r="B5" ${si(5)}</c><c r="C5" s="91"><f>65358+2000</f><v>67358</v></c><c r="D5" s="91"><v>3</v></c><c r="E5"><f>SUM(C5:D5)</f><v>67361</v></c></row>`
  + `</sheetData></worksheet>`;
function template(): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types><Override PartName="/xl/calcChain.xml" ContentType="x"/></Types>'),
    'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="November" sheetId="1" r:id="rId1"/><sheet name="By Manager" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">November!$B$1:$I$77</definedName></definedNames><calcPr calcId="191029"/></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId8" Type="calcChain" Target="calcChain.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8(`<sst>${shared.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet1),
    'xl/worksheets/sheet2.xml': strToU8(sheet2),
    'xl/drawings/drawing1.xml': strToU8('<xdr:wsDr><a:t>November 2026 Target </a:t></xdr:wsDr>'),
    'xl/calcChain.xml': strToU8('<calcChain/>'),
  });
}

describe('approval from the admin template', () => {
  it('writes the numbers into the template and keeps everything else', () => {
    const codes = new Map([['CSD_CANS150', 'CSD_CANS150'], ['CSD_SSPET500', 'CSD_SSPET500'], ['CSD_SSPET400', 'CSD_SSPET400'], ['Propel', 'Propel']]);
    const r = fillApprovalTemplate(template(), {
      period: '2027-01',
      target: { CSD_CANS150: 100, CSD_SSPET500: 10, CSD_SSPET400: 5, Propel: 3 },
      yago: { CSD_CANS150: 90 }, pago: { CSD_CANS150: 80 }, plan: { CSD_CANS150: 70 },
      channels: [{ label: 'TT DMM', g: { CSD_CANS150: 60 } }, { label: 'MT', g: { CSD_CANS150: 40 } }],
      codeOf: (n) => codes.get(n) ?? null,
    });
    expect(r.missing).toEqual(['Propel']);
    expect(r.unknown).toEqual(['Old Pack']);
    const z = unzipSync(r.data);
    const s1 = strFromU8(z['xl/worksheets/sheet1.xml']!);
    expect(s1).toContain('<c r="C7" s="8"><v>100</v></c>');
    expect(s1).toContain('<c r="D7" s="8"><v>90</v></c>');
    expect(s1).toContain('<c r="F7" s="8"><v>80</v></c>');
    expect(s1).toContain('<c r="H7" s="8"><v>70</v></c>');
    // A combined row adds both packs; an unknown row is emptied; formulas stay (without their old result).
    expect(s1).toContain('<c r="C8" s="8"><v>15</v></c>');
    expect(s1).toContain('<c r="C9" s="8"/>');
    expect(s1).toContain('<c r="C10" s="12"><f>SUM(C7:C9)</f></c>');
    expect(s1).toContain('<c r="E7" s="9"><f>IFERROR(C7/D7-1,0)</f></c>');
    const s2 = strFromU8(z['xl/worksheets/sheet2.xml']!);
    expect(s2).toContain('<c r="C5" s="91"><v>60</v></c>');
    expect(s2).toContain('<c r="D5" s="91"><v>40</v></c>');
    expect(s2).toContain('<c r="B3" s="84"><v>46388</v></c>'); // 1 Jan 2027
    const wb = strFromU8(z['xl/workbook.xml']!);
    expect(wb).toContain('<sheet name="January"');
    expect(wb).toContain('January!$B$1:$I$77');
    expect(wb).toContain('fullCalcOnLoad="1"');
    expect(strFromU8(z['xl/drawings/drawing1.xml']!)).toContain('January 2027 Target');
    expect(z['xl/calcChain.xml']).toBeUndefined();
    expect(strFromU8(z['[Content_Types].xml']!)).not.toContain('calcChain');
  });
});

describe('approval template v2: YAGO by channel and the Mix sheet', () => {
  const str = ['Pack', 'New TARGET', 'YAGO Sales', 'PAGO Sales', 'AOP', 'CSD_CANS150', 'Water_500', 'Total CSD', 'TT DMM', 'MT', 'Total', 'DEPARTMENT',
    'FY 2025 Sales', 'PAGO Sales', 'YAGO Sales', 'DEC Target', 'YTD Nov Growth %', 'TT DMM - Ali', 'Other', 'Grand Total', 'CSD Target', 'DEC SOM'];
  const s = (i: number) => `t="s"><v>${i}</v>`;
  const ws = (rows: string) => `<?xml version="1.0"?><worksheet xmlns="x"><sheetData>${rows}</sheetData></worksheet>`;
  const month = ws(`<row r="1"><c r="B1" ${s(0)}</c><c r="C1" ${s(1)}</c><c r="D1" ${s(2)}</c><c r="E1" ${s(3)}</c><c r="F1" ${s(4)}</c></row>`
    + `<row r="2"><c r="B2" ${s(5)}</c></row><row r="3"><c r="B3" ${s(6)}</c></row>`
    + `<row r="4"><c r="B4" ${s(7)}</c><c r="C4"><f>SUM(C2:C2)</f></c></row>`);
  // By Manager: the total column shares its formula (only the first cell holds the text).
  const byMgr = ws(`<row r="1"><c r="B1" ${s(0)}</c><c r="C1" ${s(8)}</c><c r="D1" ${s(9)}</c><c r="E1" ${s(10)}</c></row>`
    + `<row r="2"><c r="B2" ${s(5)}</c><c r="C2"><v>1</v></c><c r="D2"><v>2</v></c><c r="E2"><f t="shared" ref="E2:E3" si="0">SUM(C2:D2)</f><v>3</v></c></row>`
    + `<row r="3"><c r="B3" ${s(7)}</c><c r="C3"><f>SUM(C2:C2)</f></c><c r="D3"><f>SUM(D2:D2)</f></c><c r="E3"><f t="shared" si="0"/><v>3</v></c></row>`);
  const yago = ws(`<row r="5"><c r="B5" ${s(0)}</c><c r="C5" ${s(8)}</c><c r="D5" ${s(9)}</c><c r="E5" ${s(10)}</c></row>`
    + `<row r="6"><c r="B6" ${s(5)}</c><c r="C6" s="1"/><c r="D6" s="1"/><c r="E6" s="1"/></row><row r="7"><c r="B7" ${s(7)}</c><c r="C7" s="2"/></row>`);
  const mix = ws(`<row r="1"><c r="A1" ${s(20)}</c></row><row r="2"><c r="A2"><v>1</v></c></row>`
    + `<row r="5"><c r="A5" ${s(11)}</c><c r="B5" ${s(12)}</c><c r="C5" ${s(21)}</c><c r="D5" ${s(13)}</c><c r="E5" ${s(14)}</c><c r="F5" ${s(15)}</c><c r="G5" ${s(16)}</c></row>`
    + `<row r="6"><c r="A6" ${s(17)}</c><c r="B6"><v>0.5</v></c><c r="C6"><f>F6/F9</f></c><c r="D6"><v>9</v></c><c r="E6"><v>9</v></c><c r="F6"><v>9</v></c><c r="G6"><v>9</v></c></row>`
    + `<row r="7"><c r="A7" ${s(9)}</c><c r="B7"><v>0.5</v></c><c r="C7"><f>F7/F9</f></c><c r="D7"><v>9</v></c></row>`
    + `<row r="8"><c r="A8" ${s(18)}</c><c r="B8"><v>0.5</v></c><c r="C8"><f>F8/F9</f></c><c r="D8"><v>9</v></c></row>`
    + `<row r="9"><c r="A9" ${s(19)}</c><c r="B9"><f>SUM(B6:B8)</f></c></row>`);
  const files = { month, byMgr, yago, mix };
  const tpl = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(`<workbook xmlns:r="r"><sheets>${Object.keys(files).map((k, i) => `<sheet name="${['December', 'By Manager', 'YAGO CSD Sales', 'Mix'][i]}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<Relationships>${Object.keys(files).map((k, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/${k}.xml"/>`).join('')}</Relationships>`),
    'xl/sharedStrings.xml': strToU8(`<sst>${str.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`),
    ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`xl/worksheets/${k}.xml`, strToU8(v)])),
  });

  it('fills YAGO / PAGO / AOP, the YAGO sheet by channel with its totals, and the Mix sheet', () => {
    const codes = new Map([['CSD_CANS150', 'CSD_CANS150'], ['Water_500', 'Water_500']]);
    const sales = (n: number) => ({ '2026-12': { CSD_CANS150: n }, '2026-11': { CSD_CANS150: 2 * n }, '2026-01': { CSD_CANS150: n }, '2025-01': { CSD_CANS150: n / 2 }, '2025-06': { CSD_CANS150: n } });
    const r = fillApprovalTemplate(tpl, {
      period: '2027-12', target: { CSD_CANS150: 100, Water_500: 50 }, yago: { CSD_CANS150: 90 }, pago: { CSD_CANS150: 80 }, plan: { CSD_CANS150: 70 },
      channels: [{ label: 'TT DMM', g: { CSD_CANS150: 60, Water_500: 50 }, sales: sales(30) }, { label: 'MT', g: { CSD_CANS150: 40 }, sales: sales(10) }],
      catOf: (p) => (p.startsWith('CSD') ? 'CSD' : 'Water'),
      codeOf: (n) => codes.get(n) ?? null,
    });
    const z = unzipSync(r.data);
    const sh = (k: string) => strFromU8(z[`xl/worksheets/${k}.xml`]!);
    expect(sh('month')).toContain('<c r="D2"><v>90</v></c>');
    expect(sh('month')).toContain('<c r="E2"><v>80</v></c>');
    expect(sh('month')).toContain('<c r="F2"><v>70</v></c>');
    // Totals follow the first sheet: a pack row's total column adds its channels, a total row takes the first sheet's formula.
    expect(sh('byMgr')).toContain('<c r="E2"><f>C2+D2</f></c>');
    expect(sh('byMgr')).toContain('<c r="E3"><f>SUM(E2:E2)</f></c>');
    // YAGO of the target month a year before (2026-12), per channel; totals from By Manager's formulas.
    const y = sh('yago');
    expect(y).toContain('<c r="C6" s="1"><v>30</v></c>');
    expect(y).toContain('<c r="D6" s="1"><v>10</v></c>');
    expect(y).toContain('<c r="E6" s="1"><f>C6+D6</f></c>');
    expect(y).toContain('<c r="C7" s="2"><f>SUM(C6:C6)</f></c>');
    // Mix: CSD only; "TT DMM - Ali" is the channel TT DMM; FY 2026 share, PAGO (2027-11: none), YAGO, target, YTD growth.
    const m = sh('mix');
    expect(m).toContain('<c r="A2"><v>100</v></c>');
    expect(m).toContain('<c r="B6"><v>0.75</v></c>');
    expect(m).toContain('<c r="C6"><f>F6/F9</f></c>');
    expect(m).toContain('<c r="D6"><v>0</v></c>');
    expect(m).toContain('<c r="E6"><v>30</v></c>');
    expect(m).toContain('<c r="F6"><v>60</v></c>');
    expect(m).toContain('<c r="B7"><v>0.25</v></c>');
    expect(m).toContain('<c r="D8"/>');
    expect(r.unmatched).toEqual(['Other']);
    // Headers follow the month: DEC stays DEC, FY 2025 -> FY 2026, YTD Nov stays Nov.
    expect(strFromU8(z['xl/sharedStrings.xml']!)).toContain('<t>FY 2026 Sales</t>');
  });
});
