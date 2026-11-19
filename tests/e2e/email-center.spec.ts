import 'dotenv/config';
import { expect, test } from '@playwright/test';

/**
 * Acceptance criteria 25 to 30 at the browser boundary: the marketing widget the
 * plan allows on public pages, the internal runner endpoints and the
 * transactional-mail entry points.
 *
 * The widget assertions cover the LOADER contract the SaaS owns. Whether the
 * Email Center actually serves `email-center-widget.js` is that project's
 * deployment fact, and a run without it is reported as blocked, not as a pass.
 */
const widgetEnabled =
  process.env.FEATURE_EMAIL_CENTER_WIDGET === 'true' && Boolean(process.env.EMAIL_CENTER_URL);

test('the widget loader mounts the remote script with the site key on the public page', async ({ page }) => {
  test.skip(!widgetEnabled, 'blocked: the Email Center widget is not configured (FEATURE_EMAIL_CENTER_WIDGET / EMAIL_CENTER_URL)');

  await page.goto('/zh-CN');
  const script = page.locator('script[data-app-key]');
  await expect(script).toHaveCount(1);
  const expected = new URL('/email-center-widget.js?v=3', process.env.EMAIL_CENTER_URL!).href;
  expect(await script.getAttribute('src')).toBe(expected);
  expect(await script.getAttribute('data-product-name')).toBe('SaaS Framework');
  // The runtime opens it on arrival; the assertion said `false` long after the
  // loader was changed to auto-open, and the skip below hid the drift.
  expect(await script.getAttribute('data-open')).toBe('true');
});

test('the widget is told the page language rather than falling back to the browser', async ({ page }) => {
  test.skip(!widgetEnabled, 'blocked: the Email Center widget is not configured (FEATURE_EMAIL_CENTER_WIDGET / EMAIL_CENTER_URL)');

  for (const locale of ['en', 'zh-CN']) {
    await page.goto(`/${locale}`);
    await expect(page.locator('script[data-app-key]')).toHaveAttribute('data-locale', locale);
  }
});

test('the widget is not injected at all when the capability is off', async ({ page }) => {
  test.skip(widgetEnabled, 'the widget is enabled in this environment; the disabled path cannot be observed here');
  await page.goto('/zh-CN');
  await expect(page.locator('script[data-app-key]')).toHaveCount(0);
});

test('the private surfaces never load the marketing widget', async ({ page }) => {
  for (const path of ['/zh-CN/sign-in', '/zh-CN/privacy', '/zh-CN/terms']) {
    await page.goto(path);
    await expect(page.locator('script[data-app-key]'), path).toHaveCount(0);
  }
});

test('the internal runner endpoints refuse to run for an anonymous caller', async ({ request }) => {
  for (const path of [
    '/api/internal/email-center/sync',
    '/api/internal/email-center/reconcile',
    '/api/internal/payment-center/reconcile',
  ]) {
    const response = await request.post(path);
    expect(response.headers()['cache-control'], path).toBe('no-store');
    if (process.env.RECOVERY_RUNNER_MODE !== 'cron') {
      // The runners are launched by hand or by a container, so the endpoint says
      // so and does nothing. That is the honest answer, not an authorization
      // failure it cannot yet evaluate.
      expect(response.status(), path).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: 'runner_disabled' });
    } else {
      expect(response.status(), path).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    }
  }
});

test('the internal runner endpoints reject a wrong bearer secret when cron mode is on', async ({ request }) => {
  test.skip(
    process.env.RECOVERY_RUNNER_MODE !== 'cron',
    'blocked: RECOVERY_RUNNER_MODE is not "cron", so the bearer path cannot be exercised',
  );
  const response = await request.post('/api/internal/email-center/sync', {
    headers: { Authorization: `Bearer ${'0'.repeat(40)}` },
  });
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
});

test('the password-reset entry point is reachable and the reset page handles a bad link', async ({ page }) => {
  // `PasswordResetFlow` renders the form only when the transactional-mail
  // adapter is configured; it is the capability that decides, because a form
  // that cannot send anything would be the dishonest surface.
  const available = Boolean(process.env.RESEND_API_KEY?.trim()) && process.env.FEATURE_TRANSACTIONAL_EMAIL === 'true';

  // Next.js keeps its own `role="alert"` route announcer in the DOM once the
  // router has hydrated, so the page's own notice has to be matched by
  // exclusion: `getByRole('alert')` alone resolves to both of them and fails
  // strict mode as soon as the announcer exists.
  const pageAlert = page.locator('[role="alert"]:not(#__next-route-announcer__)');

  await page.goto('/zh-CN/forgot-password');
  await expect(page.locator('h1')).not.toBeEmpty();
  if (available) {
    await expect(page.locator('form')).toBeVisible();
  } else {
    await expect(pageAlert.first()).not.toBeEmpty();
    await expect(page.locator('form')).toHaveCount(0);
  }

  await page.goto('/zh-CN/reset-password?token=not-a-real-token');
  await expect(page.locator('body')).not.toBeEmpty();
  // A token that cannot be used is reported, whether the failure is the
  // adapter being off or the link itself being invalid.
  await expect.poll(async () => pageAlert.count(), { timeout: 15_000 }).toBeGreaterThan(0);
});
