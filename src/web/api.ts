// Thin fetch wrapper. Every call is JSON; body-less writes send `{}` because the
// server refuses any other content type (415). A 401 anywhere raises the
// `auth:expired` event so the app can go back to the login screen.

export class ApiError extends Error {
  readonly status: number;
  readonly body: { error?: string; detail?: string; [k: string]: unknown };
  constructor(status: number, body: ApiError['body']) {
    super(body.error ?? `http_${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export const AUTH_EXPIRED = 'auth:expired';

/** Login answers 401 for a wrong password; that is not an expired session. */
const NO_EXPIRY_EVENT = new Set(['/api/auth/login']);

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (method !== 'GET') {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: 'bad_response' };
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !NO_EXPIRY_EVENT.has(path)) window.dispatchEvent(new CustomEvent(AUTH_EXPIRED));
    throw new ApiError(res.status, (data ?? {}) as ApiError['body']);
  }
  return data as T;
}
