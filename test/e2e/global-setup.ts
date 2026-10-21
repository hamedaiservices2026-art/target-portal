import { seed } from '../../scripts/seed-dev.ts';

// The webServer (playwright.config.ts) has just started on a fresh database.
export default async function globalSetup(): Promise<void> {
  await seed('http://localhost:8799', 'admin-pass-123', () => {});
}
