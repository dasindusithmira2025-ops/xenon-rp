import { defineConfig, devices } from '@playwright/test';

import { e2eDatabaseUrl } from './e2e/database';

/**
 * End-to-end tests.
 *
 * Against `next dev` rather than a production build, and the reason is the dev
 * sign-in route: it refuses to exist when NODE_ENV is production, which is
 * exactly the guard that makes it safe to ship. Driving a real Discord OAuth
 * flow instead would need live credentials and a session on discord.com, so
 * the tradeoff is to run here and let `pnpm build` in CI answer for the
 * production bundle separately.
 *
 * The suite has its own database, derived from DATABASE_URL, seeded with the
 * same fixtures `pnpm db:seed:dev` produces.
 */

const PORT = 3201;
// `localhost`, not `127.0.0.1`: the dev server blocks cross-origin requests to
// its own /_next resources, and treats the two spellings as different origins.
// The result is a page that never hydrates and sits on its loading fallback.
const baseURL = `http://localhost:${String(PORT)}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  // One worker: the suite signs in as shared fixture accounts and submits a
  // shared application. Parallel workers would race over the same rows.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI === undefined ? 0 : 1,
  reporter: process.env.CI === undefined ? [['list']] : [['github'], ['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    // A real phone profile rather than a narrow desktop window: touch targets
    // and `hover` media queries behave differently, and mobile is not a shrunk
    // desktop.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],

  webServer: {
    command: `pnpm exec next dev --port ${String(PORT)}`,
    url: baseURL,
    reuseExistingServer: process.env.CI === undefined,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      DATABASE_URL: e2eDatabaseUrl(),
      NEXT_PUBLIC_SITE_URL: baseURL,
      AUTH_URL: baseURL,
      AUTH_TRUST_HOST: 'true',
      AUTH_DEV_LOGIN: 'true',
      // Its own build directory, so `pnpm dev` can stay running alongside.
      NEXT_DIST_DIR: '.next-e2e',
    },
  },
});
