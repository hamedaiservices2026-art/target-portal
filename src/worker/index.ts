import { Hono } from 'hono';
import type { AppEnv } from './auth';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import workRoutes from './routes/work';

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Secret. First-run admin password; see routes/auth.ts. Unset once the admin exists. */
  BOOTSTRAP_ADMIN_PASSWORD?: string;
  /** Var. Absolute base URL of the app (e.g. https://target-portal.example.workers.dev) for links; defaults to the request origin. */
  APP_URL?: string;
};

const app = new Hono<AppEnv>();

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

export default app;
