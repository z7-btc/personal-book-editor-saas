import 'dotenv/config';
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

/**
 * Acceptance criteria 2, 29, 40, 41 and 42 at the browser boundary: the locale
 * entry point, the noindex surface, the session gate in front of the dashboard
 * and one full registration that ends with a real session.
 *
 * The registration writes a REAL user into the development database (the same
 * database the smoke scripts use). It is deleted again in `afterAll`; a cleanup
 * that cannot finish is reported by name instead of silently leaving rows.
 */
const createdEmails: string[] = [];

test.afterAll(async () => {
  if (createdEmails.length === 0) return;
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    for (const email of createdEmails) {
      const rows = await client<{ id: string }[]>`SELECT id FROM "user" WHERE email = ${email}`;
      for (const row of rows) {
        // The personal workspace is created by ensurePersonalWorkspace; the
        // member row cascades with the user but the organization would not.
        await client`DELETE FROM organization WHERE id IN (SELECT organization_id FROM member WHERE user_id = ${row.id})`;
        await client`DELETE FROM "user" WHERE id = ${row.id}`;
      }
    }
  } catch (error) {
    console.warn(
      `[e2e.auth] Could not remove the accounts created by this run: ${(error as Error).message}`,
    );
  } finally {
    await client.end({ timeout: 5 });
  }
});

test('the root redirects to a locale and varies on the fields that choose it', async ({ request }) => {
  const response = await request.get('/', { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers()['location']).toMatch(/\/(zh-CN|en)$/);

  const vary = response.headers()['vary'] ?? '';
  expect(vary).toContain('Cookie');
  expect(vary).toContain('Accept-Language');
});

test('the locale cookie, not the browser language, decides the root redirect', async ({ request }) => {
  const response = await request.get('/', {
    maxRedirects: 0,
    headers: { 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'NEXT_LOCALE=en' },
  });
  expect(response.status()).toBe(307);
  expect(response.headers()['location']).toMatch(/\/en$/);
});

test('the sign-in and sign-up pages are reachable in both locales and are not indexable', async ({ page }) => {
  for (const locale of ['zh-CN', 'en'] as const) {
    for (const surface of ['sign-in', 'sign-up'] as const) {
      await page.goto(`/${locale}/${surface}`);
      await expect(page.locator('form')).toBeVisible();
      await expect(page.locator('h1')).not.toBeEmpty();
      const robots = await page.locator('meta[name="robots"]').getAttribute('content');
      expect(robots ?? '').toContain('noindex');
    }
  }
});

test('an anonymous visitor cannot reach the dashboard', async ({ page }) => {
  await page.goto('/zh-CN/dashboard');
  await expect(page).toHaveURL(/\/zh-CN\/sign-in$/);
});

test('a new account registers, lands on the dashboard and can sign out', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const email = `e2e-${suffix}@example.test`;
  createdEmails.push(email);

  await page.goto('/zh-CN/sign-up');
  await page.locator('input[autocomplete="name"]').fill(`E2E ${suffix}`);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill('e2e-local-password-1');
  await page.getByRole('button', { name: /创建|Create/i }).click();

  await expect(page).toHaveURL(/\/zh-CN\/dashboard$/, { timeout: 30_000 });
  // The dashboard renders the personal workspace the bootstrap guarantees.
  await expect(page.locator('aside')).toBeVisible();

  // Signing out is a state-changing request, so Better Auth applies its origin
  // check; an APIRequestContext does not send one on its own and the request is
  // refused before the session is ever read.
  const signOut = await page.request.post('/api/auth/sign-out', {
    data: {},
    headers: { Origin: process.env.APP_BASE_URL ?? 'http://localhost:3000' },
  });
  expect(signOut.ok(), `sign-out answered ${signOut.status()}: ${await signOut.text()}`).toBeTruthy();
  await page.goto('/zh-CN/dashboard');
  await expect(page).toHaveURL(/\/zh-CN\/sign-in$/);
});
