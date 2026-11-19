import { expect, test } from '@playwright/test';

/**
 * The browser console is part of the surface: React 19 reports a script that a
 * component renders as an error, and the theme used to be applied by exactly
 * such a script. A language switch re-renders the `[locale]` layout, so it was
 * the interaction that surfaced it — and the layout is the only place the theme
 * could be applied before the first paint.
 *
 * This spec is the regression guard for that fix: the theme now arrives as a
 * class rendered by the server from a cookie, no component renders a script,
 * and the console stays clean across a locale switch, a theme switch, a client
 * navigation and a reload. It is deliberately an assertion about the console
 * rather than about the theme, because "no error is reported" is the property
 * that broke.
 */
test('reports no console error while the visitor switches locale, theme and page', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().split('\n')[0]?.slice(0, 300) ?? '');
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message.split('\n')[0]?.slice(0, 300) ?? ''}`));

  /**
   * The Email Center widget points at the sibling application named by
   * `EMAIL_CENTER_URL`. When that application is not running — which is the
   * normal state of a local checkout, and the state this suite runs in — the
   * browser reports the refused connection. That is an honest environment
   * fact, not a defect in this repository, so it is the one entry allowed
   * through; everything else has to be empty.
   */
  const allowed = /net::ERR_CONNECTION_REFUSED/;

  await page.goto('/zh-CN', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const languageSelect = page.locator('select').filter({ has: page.locator('option[value="en"]') });
  await languageSelect.selectOption('en');
  await page.waitForURL(/\/en(\/|$)/);
  await page.waitForTimeout(2000);

  await page.locator('select').filter({ has: page.locator('option[value="system"]') }).selectOption('dark');
  await page.waitForTimeout(1000);

  await page.getByRole('link', { name: /pricing/i }).first().click();
  await page.waitForURL(/\/en\/pricing$/);
  await page.waitForTimeout(1500);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  await page.locator('select').filter({ has: page.locator('option[value="zh-CN"]') }).selectOption('zh-CN');
  await page.waitForURL(/\/zh-CN(\/|$)/);
  await page.waitForTimeout(2000);

  const unexpected = errors.filter((text) => !allowed.test(text));
  expect(
    unexpected,
    `the browser console reported ${unexpected.length} unexpected message(s): ${unexpected.join(' | ')}`,
  ).toHaveLength(0);

  // Stated separately from the filter above so that a future relaxation of the
  // allow-list cannot quietly re-admit the exact regression this spec exists
  // for.
  expect(errors.join('\n')).not.toMatch(/script tag while rendering React component|Scripts inside React components/);
});
