import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, parseRules, personCaps } from '../../src/worker/services/rulesSettings';

describe('cap on/off and exceptions', () => {
  it('the cap is applied unless switched off', () => {
    expect(DEFAULT_RULES.enabled).toBe(true);
    expect(parseRules(JSON.stringify({ caps: { head: 3, manager: 3, supervisor: 3 } })).enabled).toBe(true);
    expect(parseRules(JSON.stringify({ enabled: false })).enabled).toBe(false);
  });
  it('an exception matches a Head or manager name, ignoring case', () => {
    const r = parseRules(JSON.stringify({ exceptions: [{ name: 'Ahmed Ali', pct: 10 }] }));
    expect(personCaps(r, ['ahmed ali', 'Other'])).toEqual([10, undefined]);
  });
});
