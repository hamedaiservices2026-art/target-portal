// Who is signed in. A tiny store so any component can read it.
import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from './api';
import { applyLang, getLang, langChosenWhileSignedOut, persistLang, setSignedIn, type Lang } from './i18n';

export type User = { id: number; role: 'admin' | 'manager'; lang: Lang; name: string; cd?: ('ops' | 'ka')[]; mustChangePw?: boolean };
export type Session = { status: 'loading' | 'in' | 'out'; user: User | null };

let state: Session = { status: 'loading', user: null };
const listeners = new Set<() => void>();

function set(next: Session): void {
  state = next;
  setSignedIn(next.status === 'in');
  listeners.forEach((fn) => fn());
}

export function useSession(): Session {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }, []);
  return state;
}

/** The account's language wins when it is loaded (page load, or login without a choice made on the login screen). */
function enter(user: User): void {
  set({ status: 'in', user });
  applyLang(user.lang);
}

export async function loadSession(): Promise<void> {
  try {
    const { user } = await api<{ user: User }>('GET', '/api/me');
    enter(user);
  } catch (e) {
    if (e instanceof ApiError && e.status !== 401) throw e;
    set({ status: 'out', user: null });
  }
}

export async function login(username: string, password: string): Promise<void> {
  const carry = langChosenWhileSignedOut();
  const chosen = getLang();
  const { user } = await api<{ user: User }>('POST', '/api/auth/login', { username, password });
  if (carry && chosen !== user.lang) {
    // The person picked a language on the login screen: keep it and save it to the account.
    set({ status: 'in', user: { ...user, lang: chosen } });
    void persistLang(chosen);
  } else {
    enter(user);
  }
}

export async function logout(): Promise<void> {
  try {
    await api('POST', '/api/auth/logout', {});
  } catch { /* the cookie may already be gone; either way we are signed out */ }
  set({ status: 'out', user: null });
}

/** A 401 anywhere: forget the user (the app then routes to /login). */
export function expire(): void {
  if (state.status !== 'out') set({ status: 'out', user: null });
}
