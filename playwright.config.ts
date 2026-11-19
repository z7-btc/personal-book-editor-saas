import { defineConfig, devices } from '@playwright/test';

/**
 * The browser checks the plan asks for under `tests/e2e/`.
 *
 * They run against a REAL local dev server and the development database, which
 * is the same database every smoke script in `scripts/` already uses. Unlike the
 * Vitest files, the browser suite needs one shared server (a session cookie and
 * a redirect chain cannot be observed across two databases), so it is serial:
 * `workers: 1`, no parallelism.
 *
 * Every spec that needs a third party — the Payment Center on
 * `PAYMENT_CENTER_BASE_URL`, the Email Center on `EMAIL_CENTER_URL`, a real
 * inbox — checks its precondition first and SKIPS with the missing prerequisite
 * named. A skip is the honest result; a fabricated pass is not.
 *
 * Run it with `npm run test:e2e`. Set `E2E_BASE_URL` to point at an already
 * running server instead of letting Playwright start `npm run dev`.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    locale: 'zh-CN',
  },
  projects: [
    {
      // Chromium only: the other engines are not installed in this environment,
      // and a project that cannot start would be a failing test rather than a
      // missing one.
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
