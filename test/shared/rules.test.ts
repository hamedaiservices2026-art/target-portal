import { describe, expect, it } from 'vitest';
import { capFor, checkAll, checkPack, parseCaseInput } from '../../src/shared/rules';

describe('capFor', () => {
  it('is floor(capPct * total / 100)', () => {
    expect(capFor(1000, 5)).toBe(50);
    expect(capFor(950, 5)).toBe(47);
    expect(capFor(19, 5)).toBe(0);
    expect(capFor(20, 5)).toBe(1);
  });

  it('is exact at boundaries where naive float math drifts', () => {
    expect(capFor(0, 5)).toBe(0);
    expect(capFor(100, 5)).toBe(5);
    expect(capFor(27500, 5)).toBe(1375);
    expect(capFor(1000, 2.5)).toBe(25);
    expect(capFor(40, 2.5)).toBe(1);
    expect(capFor(1000, 0)).toBe(0);
    expect(capFor(1000, 100)).toBe(1000);
    // 0.07 * 100 = 7.000000000000001 in floats
    expect(capFor(100, 0.07)).toBe(0);
    expect(capFor(10000, 0.07)).toBe(7);
  });
});

describe('checkPack', () => {
  it('accepts moves within the cap, in either direction', () => {
    expect(checkPack(1000, [700, 300], [650, 350], 5).status).toBe('ok');
    expect(checkPack(1000, [700, 300], [750, 250], 5).status).toBe('ok');
    expect(checkPack(1000, [700, 300], [650, 350], 5).ok).toBe(true);
  });

  it('accepts exactly-at-cap and unchanged packs', () => {
    expect(checkPack(1000, [700, 300], [700, 300], 5)).toMatchObject({ ok: true, status: 'ok', moved: 0, cap: 50 });
    expect(checkPack(1000, [700, 300], [650, 350], 5)).toMatchObject({ moved: 50, cap: 50, diff: 0, sum: 1000, total: 1000 });
  });

  it('flags a move one case beyond the cap', () => {
    const r = checkPack(1000, [700, 300], [649, 351], 5);
    expect(r.status).toBe('moved_too_much');
    expect(r.ok).toBe(false);
    expect(r.moved).toBe(51);
  });

  it('flags total movement above the cap even when each child is within it', () => {
    expect(checkPack(1000, [250, 250, 250, 250], [200, 200, 300, 300], 5)).toMatchObject({
      status: 'moved_too_much',
      moved: 100,
      cap: 50,
    });
  });

  it('flags uneven moves whose total exceeds the cap', () => {
    const r = checkPack(1000, [500, 250, 250], [440, 310, 250], 5);
    expect(r).toMatchObject({ status: 'moved_too_much', moved: 60, cap: 50, diff: 0 });
    expect(checkPack(1000, [500, 250, 250], [450, 275, 275], 5).status).toBe('ok');
  });

  it('reports short when the sum is below the total, and still reports moved and cap', () => {
    expect(checkPack(27500, [5015, 8234, 6278, 7973], [4815, 8234, 6278, 7973], 5)).toMatchObject({
      ok: false,
      status: 'short',
      diff: -200,
      sum: 27300,
      total: 27500,
      moved: 0,
      cap: 1375,
    });
  });

  it('reports over when the sum is above the total, and still reports moved and cap', () => {
    expect(checkPack(1000, [700, 300], [760, 300], 5)).toMatchObject({
      ok: false,
      status: 'over',
      diff: 60,
      moved: 60,
      cap: 50,
    });
  });

  it('prefers over/short to moved_too_much when both apply', () => {
    expect(checkPack(1000, [700, 300], [900, 300], 5).status).toBe('over');
    expect(checkPack(1000, [700, 300], [500, 300], 5).status).toBe('short');
  });

  it('handles a zero total', () => {
    expect(checkPack(0, [0, 0], [0, 0], 5).ok).toBe(true);
    expect(checkPack(0, [0, 0], [1, 0], 5).status).toBe('over');
    expect(checkPack(0, [0, 0], [1, 0], 5)).toMatchObject({ diff: 1, moved: 1, cap: 0 });
  });

  it('with a zero cap, any change fails (even a swap that keeps the sum)', () => {
    expect(checkPack(19, [10, 9], [10, 9], 5).status).toBe('ok');
    expect(checkPack(19, [10, 9], [9, 10], 5).status).toBe('moved_too_much');
  });

  describe('invalid input fails closed (never throws, never ok, no NaN in output)', () => {
    const expectInvalid = (r: ReturnType<typeof checkPack>) => {
      expect(r.status).toBe('invalid');
      expect(r.ok).toBe(false);
      for (const n of [r.total, r.sum, r.diff, r.moved, r.cap]) expect(Number.isFinite(n)).toBe(true);
    };

    it('NaN value', () => expectInvalid(checkPack(1000, [700, 300], [Number.NaN, 300], 5)));
    it('NaN start', () => expectInvalid(checkPack(1000, [Number.NaN, 300], [700, 300], 5)));
    it('NaN total', () => expectInvalid(checkPack(Number.NaN, [700, 300], [700, 300], 5)));
    it('Infinity value', () => expectInvalid(checkPack(1000, [700, 300], [Infinity, 300], 5)));
    it('negative value', () => expectInvalid(checkPack(1000, [700, 300], [-100, 1100], 5)));
    it('negative total', () => expectInvalid(checkPack(-5, [0], [0], 5)));
    it('fractional value', () => expectInvalid(checkPack(1000, [700, 300], [700.5, 299.5], 5)));
    it('fractional start', () => expectInvalid(checkPack(1000, [700.5, 299.5], [700, 300], 5)));
    it('fractional total', () => expectInvalid(checkPack(1000.5, [700, 300], [700, 300], 5)));
    it('mismatched lengths', () => expectInvalid(checkPack(10, [5, 5], [10], 5)));
    it('NaN or negative capPct', () => {
      expectInvalid(checkPack(1000, [700, 300], [700, 300], Number.NaN));
      expectInvalid(checkPack(1000, [700, 300], [700, 300], -5));
    });

    it('invalid takes precedence over over/short', () => {
      expect(checkPack(1000, [700, 300], [900.5, 300], 5).status).toBe('invalid');
      expect(checkPack(1000, [700, 300], [-1, 300], 5).status).toBe('invalid');
    });
  });
});

describe('checkAll', () => {
  const packs = ['P1', 'P2'];
  const totals = { P1: 1000, P2: 100 };
  const starts = [
    { P1: 700, P2: 60 },
    { P1: 300, P2: 40 },
  ];

  it('is ok when every pack passes', () => {
    const r = checkAll(totals, starts, [{ P1: 650, P2: 62 }, { P1: 350, P2: 38 }], packs, 5);
    expect(r.ok).toBe(true);
    expect(r.byPack.P1?.status).toBe('ok');
    expect(r.byPack.P2?.status).toBe('ok');
  });

  it('is not ok when any pack fails, and reports each pack separately', () => {
    const r = checkAll(totals, starts, [{ P1: 650, P2: 70 }, { P1: 350, P2: 30 }], packs, 5);
    expect(r.ok).toBe(false);
    expect(r.byPack.P1?.status).toBe('ok');
    expect(r.byPack.P2).toMatchObject({ status: 'moved_too_much', moved: 10, cap: 5 });
  });

  it('treats missing pack entries as 0', () => {
    const r = checkAll({ P1: 10 }, [{ P1: 10 }, {}], [{ P1: 10 }, {}], ['P1', 'P2'], 5);
    expect(r.ok).toBe(true);
    expect(r.byPack.P2).toMatchObject({ total: 0, sum: 0, status: 'ok' });
  });

  it('is not ok when a pack has invalid input (NaN)', () => {
    const r = checkAll(totals, starts, [{ P1: Number.NaN, P2: 60 }, { P1: 350, P2: 40 }], packs, 5);
    expect(r.ok).toBe(false);
    expect(r.byPack.P1?.status).toBe('invalid');
    expect(r.byPack.P2?.status).toBe('ok');
  });

  it('is ok for an empty pack list', () => {
    expect(checkAll({}, [], [], [], 5)).toEqual({ ok: true, byPack: {} });
  });
});

describe('parseCaseInput', () => {
  it('parses plain and thousands-separated digits with surrounding spaces', () => {
    expect(parseCaseInput(' 1,200 ')).toBe(1200);
    expect(parseCaseInput('0')).toBe(0);
    expect(parseCaseInput('350')).toBe(350);
    expect(parseCaseInput('1,234,567')).toBe(1234567);
    expect(parseCaseInput(' 42\t')).toBe(42);
  });

  it('parses Arabic-Indic and Persian digits', () => {
    expect(parseCaseInput('٣٥٠')).toBe(350);
    expect(parseCaseInput('۱۲۰۰')).toBe(1200);
    expect(parseCaseInput('٠')).toBe(0);
    expect(parseCaseInput('١,٢٠٠')).toBe(1200);
    expect(parseCaseInput('1٢3')).toBe(123);
  });

  it('ignores invisible bidi marks around the number', () => {
    expect(parseCaseInput('‏٣٥٠‎')).toBe(350);
  });

  it('returns null for empty, decimals, negatives and other text', () => {
    for (const bad of ['', '   ', '12.5', '-3', '+3', 'abc', '12a', '1 200', '1,2', '12,00', ',100', '100,', '1,,000', '٣.٥', '-٣', '1e3', '0x10']) {
      expect(parseCaseInput(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('returns null beyond the safe integer range', () => {
    expect(parseCaseInput('9007199254740993')).toBeNull();
  });
});
