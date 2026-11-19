import 'dotenv/config';
import { expect, test } from '@playwright/test';

/**
 * Acceptance criteria 9, 13, 17 and 18 at the browser boundary: the pricing
 * surface tells the truth about whether checkout is open, the private billing
 * data is never reachable anonymously, and the checkout form only exists when
 * the Payment Center connection is configured.
 *
 * The "catalog is rendered" case needs the local Payment Center on
 * `PAYMENT_CENTER_BASE_URL` to answer with products. When it does not, the test
 * SKIPS and names that prerequisite instead of inventing a passing state.
 */
test('the pricing page is public, localised and honest about the checkout gate', async ({ page }) => {
  for (const [locale, copy] of [
    ['zh-CN', '完成 Payment Center 连接与验收后才会开放付款。'],
    ['en', 'Checkout opens after Payment Center is connected and verified.'],
  ] as const) {
    await page.goto(`/${locale}/pricing`);
    await expect(page.locator('h1')).toHaveText(/定价|Pricing/);
    const connected = process.env.FEATURE_PAYMENT_CENTER === 'true';
    if (!connected) {
      await expect(page.getByText(copy)).toBeVisible();
      // No plan card, no payment-method selector and no checkout button. The
      // selector is scoped to the catalog so the site header cannot be mistaken
      // for a payment-method control.
      await expect(page.locator('article')).toHaveCount(0);
      await expect(page.locator('select[id^="method-"]')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /付款|payment/i })).toHaveCount(0);
    }
  }
});

test('the pricing page publishes structured data for its own locale', async ({ page }) => {
  await page.goto('/en/pricing');
  const jsonLd = await page.locator('script[type="application/ld+json"]').first().textContent();
  expect(jsonLd).toBeTruthy();
  const parsed = JSON.parse(jsonLd!) as Record<string, unknown>;
  expect(parsed['@type']).toBe('WebPage');
  expect(String(parsed.url)).toMatch(/\/en\/pricing$/);
  expect(parsed.inLanguage).toBe('en');
});

test('the billing and activity APIs reject an anonymous caller with a private cache', async ({ request }) => {
  for (const path of ['/api/account/billing', '/api/account/activity']) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    expect(response.headers()['cache-control']).toBe('private, no-store');
    // The route sets `Vary: Cookie`; Next.js appends its own router fields to
    // the same header, so the check is containment rather than equality.
    expect(response.headers()['vary']).toContain('Cookie');
  }
});

test('the billing and activity pages stay behind the session gate', async ({ page }) => {
  for (const surface of ['billing', 'activity', 'referrals', 'general', 'security']) {
    await page.goto(`/en/dashboard/${surface}`);
    await expect(page, surface).toHaveURL(/\/en\/sign-in$/);
  }
});

test('a real catalog offers a plan button and opens the payment widget on click', async ({ page, request }) => {
  const base = process.env.PAYMENT_CENTER_BASE_URL;
  test.skip(
    process.env.FEATURE_PAYMENT_CENTER !== 'true' || !base,
    'blocked: the local Payment Center binding is switched off (FEATURE_PAYMENT_CENTER !== "true")',
  );

  let reachable = false;
  try {
    const probe = await request.get(`${base}/health`, { timeout: 5_000 });
    reachable = probe.ok();
  } catch {
    reachable = false;
  }
  test.skip(!reachable, `blocked: the local Payment Center at ${base} is not answering`);

  await page.goto('/en/pricing');
  const cards = page.locator('article');
  await expect.poll(async () => cards.count(), { timeout: 30_000 }).toBeGreaterThan(0);

  // Nothing is mounted before the buyer chooses: the plan card owns the choice,
  // the payment window owns the widget.
  await expect(page.locator('div.pcw')).toHaveCount(0);
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);

  // The billing-interval toggle is the page's own control, not the widget's.
  await expect(page.getByRole('button', { name: 'Monthly', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yearly', exact: true })).toBeVisible();

  await cards.first().getByRole('button').click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();

  // One widget, inside the dialog, showing the centre's payment methods.
  await expect(dialog.locator('div.pcw')).toHaveCount(1);
  await expect
    .poll(async () => page.locator('div.pcw').count(), { timeout: 30_000 })
    .toBe(1);
  await expect
    .poll(async () => dialog.locator('button[data-pcw-method]').count(), { timeout: 30_000 })
    .toBeGreaterThan(0);

  // The interval was locked by the page, so the widget hides its own picker.
  await expect(dialog.locator('[data-pcw="interval-field"]')).toBeHidden();
});

test('the payment widget settles a card payment without ever asking for a currency', async ({ page, request }) => {
  const base = process.env.PAYMENT_CENTER_BASE_URL;
  test.skip(
    process.env.FEATURE_PAYMENT_CENTER !== 'true' || !base,
    'blocked: the local Payment Center binding is switched off (FEATURE_PAYMENT_CENTER !== "true")',
  );

  let reachable = false;
  try {
    const probe = await request.get(`${base}/health`, { timeout: 5_000 });
    reachable = probe.ok();
  } catch {
    reachable = false;
  }
  test.skip(!reachable, `blocked: the local Payment Center at ${base} is not answering`);

  await page.goto('/en/pricing');
  const cards = page.locator('article');
  await expect.poll(async () => cards.count(), { timeout: 30_000 }).toBeGreaterThan(0);
  await cards.first().getByRole('button').click();

  const dialog = page.locator('[role="dialog"]');
  const stripe = dialog.locator('button[data-pcw-method="stripe"]');
  await expect(stripe).toBeVisible({ timeout: 30_000 });
  await stripe.click();

  // The plan's own currency decides the price. A card payment is never asked to
  // pick one — only the chain channel asks for a network and a token — and the
  // buyer can go straight to Stripe.
  await expect(dialog.locator('[data-pcw="price"]')).toContainText(/USD/);
  await expect(dialog.locator('[data-pcw="currency-field"]')).toBeHidden();
  await expect(dialog.locator('[data-pcw="chain-field"]')).toBeHidden();
  await expect(dialog.locator('[data-pcw="pay"]')).toBeEnabled();

  // The chain channel is the only one that asks for a network and a token. It is
  // offered unless the centre's monitor is down, which is the centre's call.
  const chain = dialog.locator('button[data-pcw-method="blockchain"]');
  if (await chain.count() > 0 && await chain.isEnabled()) {
    await chain.click();
    await expect(dialog.locator('[data-pcw="currency-field"]')).toBeVisible();
    await expect(dialog.locator('[data-pcw="chain-field"]')).toBeVisible();
    await stripe.click();
    await expect(dialog.locator('[data-pcw="currency-field"]')).toBeHidden();
  }
});
