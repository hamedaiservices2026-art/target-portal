// Shared by the admin route modules: ApiError becomes its JSON response.
import type { Context } from 'hono';
import type { AppEnv } from '../auth';
import { ApiError, asObject } from '../services/masters';

export type Ctx = Context<AppEnv>;
export const p = (c: Ctx, name: string): string => c.req.param(name) ?? '';

/** Wraps a handler: ApiError becomes its JSON response, anything else propagates. */
export const h = (fn: (c: Ctx, db: D1Database, actor: number, body: () => Promise<Record<string, unknown>>) => Promise<Response>) =>
  async (c: Ctx): Promise<Response> => {
    try {
      const body = async () => asObject(await c.req.json().catch(() => null));
      return await fn(c, c.env.DB, c.var.user.id, body);
    } catch (e) {
      if (e instanceof ApiError) return c.json(e.body, e.status);
      throw e;
    }
  };
