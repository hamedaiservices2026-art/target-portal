import { Hono } from 'hono';

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
};

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ ok: true }));

// Anything else under /api is an unknown endpoint. Non-/api paths never reach
// the Worker: Static Assets serves them, falling back to index.html (SPA).
app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

export default app;
