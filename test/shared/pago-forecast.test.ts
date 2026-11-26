import { describe, expect, it } from 'vitest';
import { defaultFc, fcFactor, workingDays } from '../../src/web/cycle/pagoFc';

describe('PAGO forecast closing', () => {
  it('counts working days without Fridays', () => {
    expect(workingDays('2026-11')).toBe(26); // Fridays 6, 13, 20, 27
    expect(workingDays('2026-11', 1, 25)).toBe(22);
  });
  it('actual / days x remaining days, added to the actual (the example: 3,140,616 over 21 days, 4 left)', () => {
    const k = fcFactor({ on: true, done: 21, left: 4 });
    expect(Math.round(3140616 * k)).toBe(3738829);
    expect(fcFactor({ on: false, done: 21, left: 4 })).toBe(1);
    expect(fcFactor({ on: true, done: 21, left: 0 })).toBe(1);
  });
  it('defaults from today: sales up to yesterday', () => {
    expect(defaultFc('2026-11', new Date(2026, 10, 26))).toEqual({ on: true, done: 22, left: 4 });
    expect(defaultFc('2026-10', new Date(2026, 10, 26))).toEqual({ on: false, done: 26, left: 0 });
  });
});
