import { describe, expect, it } from 'vitest';
import { explainErrors, parseMappingSheet } from '../../src/web/mapping';

describe('parseMappingSheet', () => {
  it('finds the header below a title row, ignoring case and spaces, and skips blank rows', () => {
    const r = parseMappingSheet([
      ['Route export'],
      [' delivery  system', 'ROUTE CODE', 'node', 'Label'],
      ['DS1', 101, 'North', 'Route 101'],
      [null, null, null, null],
      ['DS1', 'R2', 'North'],
    ]);
    expect(r).toEqual({
      ok: true,
      rows: [
        { deliverySystem: 'DS1', routeCode: '101', nodeName: 'North', label: 'Route 101' },
        { deliverySystem: 'DS1', routeCode: 'R2', nodeName: 'North' },
      ],
      excelRows: [3, 5],
    });
  });
  it('works without a Label column and keeps half-filled rows for the server to report', () => {
    const r = parseMappingSheet([['Delivery System', 'Route Code', 'Node'], ['DS1', '', 'North']]);
    expect(r).toEqual({ ok: true, rows: [{ deliverySystem: 'DS1', routeCode: '', nodeName: 'North' }], excelRows: [2] });
  });
  it('reports a missing header, an empty file and too many rows', () => {
    expect(parseMappingSheet([['a', 'b']])).toEqual({ ok: false, reason: 'no_header' });
    expect(parseMappingSheet([['Delivery System', 'Route Code', 'Node']])).toEqual({ ok: false, reason: 'no_rows' });
    const many = [['Delivery System', 'Route Code', 'Node'], ...Array.from({ length: 5001 }, (_, i) => ['D', `R${i}`, 'N'])];
    expect(parseMappingSheet(many)).toEqual({ ok: false, reason: 'too_many', count: 5001 });
  });
});

describe('explainErrors', () => {
  it('maps server lines (sent index + 2) back to sheet rows and splits joined problems', () => {
    const out = explainErrors([
      { line: 2, detail: 'routeCode is required; unknown node "X" in this department' },
      { line: 3, detail: 'duplicate of line 2 (same delivery system and route code)' },
      { line: 4, detail: 'something new' },
    ], [3, 7, 9]);
    expect(out).toEqual([
      { excelRow: 3, kind: 'required', vars: { column: 'Route Code' } },
      { excelRow: 3, kind: 'unknownNode', vars: { node: 'X' } },
      { excelRow: 7, kind: 'duplicate', vars: { other: 3 } },
      { excelRow: 9, kind: 'other', vars: { detail: 'something new' } },
    ]);
  });
});
