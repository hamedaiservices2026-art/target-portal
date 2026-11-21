import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Fixed port, and `localhost` (not 127.0.0.1): the session cookie is `Secure`,
// which browsers accept on http://localhost only.
const PORT = 8799;
const STATE = '.wrangler/e2e-state';
export const E2E_ADMIN_PASSWORD = 'admin-pass-123';

// CI installs the browser Playwright expects. Locally a pre-installed Chromium
// (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers) may be a different revision: use it directly.
function localChromium(): string | undefined {
  if (process.env.CI) return undefined;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root) return undefined;
  for (const sub of ['chromium-1194/chrome-linux/chrome', 'chromium/chrome-linux/chrome']) {
    if (existsSync(`${root}/${sub}`)) return `${root}/${sub}`;
  }
  return undefined;
}

export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    launchOptions: { executablePath: localChromium() },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Fresh local database every run: wipe the state dir, migrate, build, serve.
    // The seed is applied by global-setup once the server answers.
    command: [
      `rm -rf ${STATE}`,
      `npx wrangler d1 migrations apply target-portal --local --persist-to ${STATE}`,
      'npm run build',
      `npx wrangler dev --port ${PORT} --persist-to ${STATE} --var BOOTSTRAP_ADMIN_PASSWORD:${E2E_ADMIN_PASSWORD}`,
    ].join(' && '),
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
