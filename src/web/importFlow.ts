// Bulk import, browser side without DOM or i18n (unit-tested in Node): the
// templates, and the one-password-per-request staging loop for users.
import { IMPORT_COLUMNS, type ImportKind, type PasswordOp } from '../shared/imports';
import type { CellKind } from './excel';

export type Template = { fileName: string; columns: string[]; rows: (string | number)[][]; kinds: CellKind[] };

/** The .xlsx template: the exact headers and one example row (codes and names as text, Sort order as a number). */
export function templateFor(kind: ImportKind, ex: { dept?: string; parent?: string }): Template {
  const columns = [...IMPORT_COLUMNS[kind]];
  if (kind === 'users') {
    return {
      fileName: 'users-import-template.xlsx', columns,
      rows: [['example.user', 'Example User', 'manager', '', 'ar', 'example.user@example.com']],
      kinds: ['string', 'string', 'string', 'string', 'string', 'string'],
    };
  }
  if (kind === 'packs') {
    return { fileName: 'packs-import-template.xlsx', columns, rows: [['EXAMPLE_PACK', 'CSD', 100, 'yes']], kinds: ['string', 'string', 'number', 'string'] };
  }
  return {
    fileName: 'hierarchy-import-template.xlsx', columns,
    rows: [[ex.dept ?? 'TT', 'Example team', ex.parent ?? 'Head', 'example.user']],
    kinds: ['string', 'string', 'string', 'string'],
  };
}

type PasswordAnswer = { same?: boolean; ok?: true; generated?: string };
export type Generated = { username: string; password: string };

/**
 * PBKDF2 fits the free-plan CPU limit once per request, so each password is
 * its own request: an existing user's password is checked first and only
 * hashed when it differs. Returns the passwords the server generated (blank
 * cells of new users); they exist only in this page's memory.
 */
export async function stagePasswords(
  importId: string,
  pending: PasswordOp[],
  passwordByLine: Map<number, string>,
  call: (body: { importId: string; username: string; password: string; op: 'verify' | 'hash' }) => Promise<PasswordAnswer>,
  onProgress: (done: number, total: number) => void,
): Promise<Generated[]> {
  const generated: Generated[] = [];
  onProgress(0, pending.length);
  for (const [i, p] of pending.entries()) {
    const password = passwordByLine.get(p.line) ?? '';
    let op = p.op;
    if (op === 'verify') {
      const r = await call({ importId, username: p.username, password, op });
      if (!r.same) op = 'hash';
    }
    if (op === 'hash') {
      const r = await call({ importId, username: p.username, password, op });
      if (r.generated) generated.push({ username: p.username, password: r.generated });
    }
    onProgress(i + 1, pending.length);
  }
  return generated;
}

/** First-strong isolates around each value: a Latin name or number keeps its own direction inside an Arabic sentence. */
export function isolate(vars: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, `⁨${v}⁩`]));
}

/** Generated passwords to show: only for users whose password the apply really set (a user created meanwhile kept their own). */
export function shownGenerated(generated: Generated[], passwordsSet: string[] | undefined): Generated[] {
  const set = new Set(passwordsSet ?? []);
  return generated.filter((g) => set.has(g.username));
}

/** The i18n key for an import-specific server answer, or null for the general error texts. */
export function importErrorKey(
  status: number, body: { error?: string; detail?: unknown },
): 'imErrPasswordsPending' | 'imErrChanged' | 'imErrSlotTaken' | 'errTooManyAttempts' | null {
  if (status === 429) return 'errTooManyAttempts';
  if (status !== 409) return null;
  if (body.detail === 'passwords_pending') return 'imErrPasswordsPending';
  if (body.detail === 'import_changed') return 'imErrChanged';
  if (body.detail === 'import_slot_taken') return 'imErrSlotTaken';
  return null;
}
