import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import { ar } from './ar';
import { en, type TextKey } from './en';

export type Lang = 'en' | 'ar';
export type { TextKey };

const STORAGE_KEY = 'tp_lang';
const tables: Record<Lang, Record<TextKey, string>> = { en, ar };

function readStored(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'en' || v === 'ar' ? v : null;
  } catch {
    return null;
  }
}

function initial(): Lang {
  return readStored() ?? (typeof navigator !== 'undefined' && /^ar\b/i.test(navigator.language) ? 'ar' : 'en');
}

let current: Lang = initial();
let signedIn = false;
/** Set (per tab, so it survives a reload) when the language was changed on the login screen, so login can carry it to the account. */
const PICK_KEY = 'tp_lang_pick';
function pick(v?: boolean): boolean {
  try {
    if (v === true) sessionStorage.setItem(PICK_KEY, '1');
    else if (v === false) sessionStorage.removeItem(PICK_KEY);
    return sessionStorage.getItem(PICK_KEY) === '1';
  } catch {
    return false;
  }
}
const listeners = new Set<() => void>();

function reflect(): void {
  const root = document.documentElement;
  root.lang = current;
  root.dir = current === 'ar' ? 'rtl' : 'ltr';
}
reflect();

/** Applies a language locally: state, <html lang dir>, localStorage. Does not touch the server. */
export function applyLang(lang: Lang): void {
  current = lang;
  reflect();
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch { /* storage unavailable: the choice just lasts for this page */ }
  listeners.forEach((fn) => fn());
}

export const getLang = (): Lang => current;

/** The session module tells us whether PATCH /api/me is possible. */
export function setSignedIn(v: boolean): void {
  signedIn = v;
  if (v) pick(false);
}

export const langChosenWhileSignedOut = (): boolean => pick();

export function persistLang(lang: Lang): Promise<unknown> {
  return api('PATCH', '/api/me', { lang }).catch(() => undefined);
}

/** User-initiated change: applies at once, then saves to the account when signed in. */
export function setLang(lang: Lang): void {
  applyLang(lang);
  if (signedIn) void persistLang(lang);
  else pick(true);
}

export function t(key: TextKey): string {
  return tables[current][key];
}

export function useLang(): [Lang, (lang: Lang) => void] {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }, []);
  return [current, setLang];
}
