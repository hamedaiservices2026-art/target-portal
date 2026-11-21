// UI text of the target cycle screens. Each entry is [English, Arabic]; the
// keys are checked by the type of CY (cycle-text.ts). Pack codes, route codes
// and numbers are never translated; numbers keep Western digits.
import { getLang } from '../i18n';
import { CY, type CyKey } from './cycle-text';

export type { CyKey };

export function tc(key: CyKey, vars?: Record<string, string | number>): string {
  const pair = CY[key];
  const s = getLang() === 'ar' ? pair[1] : pair[0];
  return vars ? s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : s;
}
