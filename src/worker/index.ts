import { Hono } from 'hono';
import type { AppEnv } from './auth';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import workRoutes from './routes/work';
import { sendDeadlineReminders } from './email';

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Secret. First-run admin password; see routes/auth.ts. Unset once the admin exists. */
  BOOTSTRAP_ADMIN_PASSWORD?: string;
  /** Var. Absolute base URL of the app (e.g. https://target-portal.example.workers.dev) for links; defaults to the request origin. */
  APP_URL?: string;
  /** Secret. Brevo API key; without it emails are only written to email_log. */
  BREVO_API_KEY?: string;
  /** Var. The single verified sender address (also used as reply-to). */
  MAIL_FROM?: string;
  /** Set per request: hands background work (email) to waitUntil so the response does not wait for it. */
  defer?: (p: Promise<unknown>) => void;
};

export const app = new Hono<AppEnv>();

// Email: links need an absolute base (APP_URL, else this request's origin), and
// sends are deferred with waitUntil so the response never waits for Brevo.
app.use('*', async (c, next) => {
  const extra: Partial<Env> = {};
  if (!c.env.APP_URL) extra.APP_URL = new URL(c.req.url).origin;
  try {
    const ctx = c.executionCtx;
    extra.defer = (p) => ctx.waitUntil(p);
  } catch { /* no execution context (plain app.request): sends are awaited */ }
  c.env = { ...c.env, ...extra };
  await next();
});

// Ruling R12: every state-changing API call is JSON (clients send `{}` for
// body-less calls). Refusing other content types also rules out the "simple"
// cross-site form posts (text/plain, form-urlencoded) a browser sends without
// a CORS preflight.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use('/api/*', async (c, next) => {
  if (WRITE_METHODS.has(c.req.method)) {
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') return c.json({ error: 'unsupported_media_type' }, 415);
  }
  await next();
});

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/', authRoutes);
app.route('/', adminRoutes);
app.route('/', workRoutes);

// Anything else under /api is an unknown endpoint. Non-/api paths never reach
// the Worker: Static Assets serves them, falling back to index.html (SPA).
app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendDeadlineReminders(env.DB, env, new Date()));
  },
};
