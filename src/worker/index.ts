import { Hono } from 'hono';
import type { AppEnv } from './auth';
import authRoutes from './routes/auth';

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Secret. First-run admin password; see routes/auth.ts. Unset once the admin exists. */
  BOOTSTRAP_ADMIN_PASSWORD?: string;
};

const app = new Hono<AppEnv>();

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/', authRoutes);

// Anything else under /api is an unknown endpoint. Non-/api paths never reach
// the Worker: Static Assets serves them, falling back to index.html (SPA).
app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

export default app;
