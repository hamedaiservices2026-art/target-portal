import type { D1Migration } from '@cloudflare/vitest-plugin';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ASSETS: Fetcher;
      BOOTSTRAP_ADMIN_PASSWORD?: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
