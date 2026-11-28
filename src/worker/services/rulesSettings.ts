// Distribution rules settings (handover section 6): cap % per level, rules 2
// and 3 on/off, and per-person cap exceptions (a named manager, supervisor or
// route). Stored as JSON in settings.rules_json.
import { one } from '../db';
import { auditStatement } from './audit';
import { bad, writeBatch, type Obj } from './masters';

export type Level = 'head' | 'manager' | 'supervisor';
export type RulesSettings = {
  /** false = the cap is not applied at all (rules 2 and 3 off); rule 1 (packs add up) always applies. */
  enabled: boolean;
  /** kam: the Key Account managers' split (KA, level manager); falls back to manager. */
  caps: Record<Level, number> & { kam?: number };
  rule2: boolean;
  rule3: boolean;
  /** `name` = a Head, manager or supervisor name, or a route code (case-insensitive): their own cap %. */
  exceptions: { name: string; pct: number }[];
  /** Rule 2 base: 'own' = % of each person's own target (default), 'group' = % of the pack total being split. */
  base: 'own' | 'group';
};

export const DEFAULT_RULES: RulesSettings = { enabled: true, caps: { head: 5, manager: 5, supervisor: 5, kam: 5 }, rule2: true, rule3: true, exceptions: [], base: 'own' };

function pct(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw bad(`${field} must be a number from 0 to 100`);
  return v;
}

export function parseRules(raw: string | null | undefined, legacyCap?: number): RulesSettings {
  if (!raw) return legacyCap === undefined ? DEFAULT_RULES : { ...DEFAULT_RULES, caps: { head: legacyCap, manager: legacyCap, supervisor: legacyCap, kam: legacyCap } };
  try {
    const o = JSON.parse(raw) as Partial<RulesSettings>;
    return {
      enabled: o.enabled ?? true,
      caps: { ...DEFAULT_RULES.caps, kam: o.caps?.kam ?? o.caps?.manager ?? DEFAULT_RULES.caps.kam, ...(o.caps ?? {}) },
      rule2: o.rule2 ?? true,
      rule3: o.rule3 ?? true,
      exceptions: Array.isArray(o.exceptions) ? o.exceptions.filter((e) => e && typeof e.name === 'string' && typeof e.pct === 'number') : [],
      base: o.base === 'group' ? 'group' : 'own',
    };
  } catch {
    return DEFAULT_RULES;
  }
}

/** The level whose cap applies to a node's split: the root is the Head, its children managers, deeper nodes supervisors. */
export function levelOf(depth: number): Level {
  return depth === 0 ? 'head' : depth === 1 ? 'manager' : 'supervisor';
}

/** Each child's own cap %, or undefined for the level cap. */
export function personCaps(rules: RulesSettings, labels: string[]): (number | undefined)[] {
  const byName = new Map(rules.exceptions.map((e) => [e.name.trim().toLowerCase(), e.pct]));
  return labels.map((l) => byName.get(l.trim().toLowerCase()));
}

export async function getRules(db: D1Database): Promise<RulesSettings> {
  const r = await one<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'rules_json'`);
  return parseRules(r?.value);
}

export async function setRules(db: D1Database, actorId: number, body: Obj): Promise<RulesSettings> {
  const c = body.caps as Obj | undefined;
  if (!c || typeof c !== 'object') throw bad('caps must be an object with head, manager and supervisor');
  if (typeof body.rule2 !== 'boolean' || typeof body.rule3 !== 'boolean') throw bad('rule2 and rule3 must be true or false');
  if (!Array.isArray(body.exceptions)) throw bad('exceptions must be a list');
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw bad('enabled must be true or false');
  const seen = new Set<string>();
  const exceptions = body.exceptions.map((e, i) => {
    const o = e as Obj;
    if (typeof o?.name !== 'string' || !o.name.trim()) throw bad(`exception ${i + 1} needs a name`);
    const key = o.name.trim().toLowerCase();
    if (seen.has(key)) throw bad(`exception ${o.name} is listed twice`);
    seen.add(key);
    return { name: o.name.trim().slice(0, 200), pct: pct(o.pct, `exception ${o.name} %`) };
  });
  const rules: RulesSettings = {
    enabled: body.enabled === undefined ? true : body.enabled,
    caps: { head: pct(c.head, 'head cap'), manager: pct(c.manager, 'manager cap'), supervisor: pct(c.supervisor, 'supervisor cap'), kam: c.kam === undefined ? pct(c.manager, 'manager cap') : pct(c.kam, 'KAM threshold') },
    rule2: body.rule2, rule3: body.rule3, exceptions,
    base: body.base === 'group' ? 'group' : 'own',
  };
  await writeBatch(db, [
    db.prepare(`INSERT INTO settings(key, value) VALUES ('rules_json', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(rules)),
    // The old single cap follows the supervisor cap, for screens that still read it.
    db.prepare(`INSERT INTO settings(key, value) VALUES ('cap_pct', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(String(rules.caps.supervisor)),
    auditStatement(db, actorId, 'settings.rules', {}, rules),
  ], 'conflict');
  return rules;
}
