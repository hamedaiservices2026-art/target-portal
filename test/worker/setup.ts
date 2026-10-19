import { applyD1Migrations, env } from 'cloudflare:test';

// Applies migrations/*.sql (read in vitest.config.ts) to the test database.
// Already-applied migrations are skipped, so this is safe to run per test file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
