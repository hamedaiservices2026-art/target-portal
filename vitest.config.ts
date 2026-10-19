import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  // Read migrations/*.sql in Node; the worker test setup applies them to the
  // test D1 database through the TEST_MIGRATIONS binding.
  const migrations = await readD1Migrations('./migrations');

  return {
    test: {
      projects: [
        {
          test: {
            name: 'shared',
            environment: 'node',
            include: ['test/shared/**/*.test.ts'],
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './wrangler.jsonc' },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: {
            name: 'worker',
            include: ['test/worker/**/*.test.ts'],
            setupFiles: ['./test/worker/setup.ts'],
          },
        },
      ],
    },
  };
});
