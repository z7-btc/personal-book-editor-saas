import 'dotenv/config';
import { expect, test } from '@playwright/test';

/**
 * Acceptance criteria 32, 33 and 35 at the browser boundary: the public surface
 * has to hold up at the three target viewports (1440×900, 1024×768, 390×844), in
 * every locale, in light and dark, without leaking a value a screenshot must not
 * carry.
 *
 * The plan asks for a Playwright visual matrix. There are no committed baseline
 * images in this repository, so a pixel comparison would either be generated on
 * the first run (proving nothing) or fail on every honest copy change. What is
 * asserted instead is the property the matrix exists to protect: the layout does
 * not overflow, the theme and locale switches actually work, and no page renders
 * a secret, a payout account or a wallet address. A skip names its prerequisite;
 * a fabricated pass would not.
 */
const viewports = [
  { name: 'desktop 1440×900', width: 1440, height: 900 },
  { name: 'laptop 1024×768', width: 1024, height: 768 },
  { name: 'mobile 390×844', width: 390, height: 844 },
] as const;

// Playwright does not resolve this project's `@/` path alias, so the list is
// spelled out here; tests/i18n.test.ts asserts it matches i18n/routing.ts.
const locales = ['en', 'zh-CN', 'ja', 'de', 'es', 'fr'] as const;

/** The pages an anonymous visitor can reach in every locale. */
const publicPaths = ['', '/pricing', '/faq', '/privacy', '/terms'] as const;

/**
 * Values that must never reach a public page: provider secrets, a bearer token,
 * an EVM or Tron payout address, and the names of this deployment's private keys.
 */
const forbiddenInHtml: { label: string; pattern: RegExp }[] = [
  { label: 'a Resend key', pattern: /re_[A-Za-z0-9]{16,}/ },
  { label: 'a Stripe secret key', pattern: /sk_[A-Za-z0-9]{16,}/ },
  { label: 'a bearer token', pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  { label: 'an EVM address', pattern: /0x[0-9a-fA-F]{40}/ },
  { label: 'a Tron address', pattern: /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/ },
  {
    label: 'a private key name',
    pattern: /(BETTER_AUTH_SECRET|CRON_SECRET|INTEGRATION_ENCRYPTION_KEY_V1|REFERRAL_WITHDRAWAL_REQUEST_SECRET)/,
  },
];

for (const locale of locales) {
  test.describe(`${locale} public surface`, () => {
    for (const viewport of viewports) {
      test(`fits ${viewport.name} without horizontal overflow`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });

        for (const path of publicPaths) {
          const response = await page.goto(`/${locale}${path}`, { waitUntil: 'domcontentloaded' });
          expect(response?.status(), `/${locale}${path} did not render`).toBeLessThan(400);

          const measured = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            lang: document.documentElement.lang,
            body: document.body.innerText.trim().length,
          }));

          // One pixel of tolerance: a sub-pixel layout rounding must not fail the
          // check, while a real overflow (a fixed-width table, an unwrapped code
          // block, a 44px target pushed off screen) is far larger than that.
          expect(
            measured.scrollWidth,
            `/${locale}${path} overflows ${viewport.width}px by ${measured.scrollWidth - measured.clientWidth}px`,
          ).toBeLessThanOrEqual(measured.clientWidth + 1);
          expect(measured.lang, `/${locale}${path} declares the wrong language`).toBe(locale);
          expect(measured.body, `/${locale}${path} rendered an empty page`).toBeGreaterThan(0);

          const html = await page.content();
          for (const { label, pattern } of forbiddenInHtml) {
            expect(html, `/${locale}${path} served ${label}`).not.toMatch(pattern);
          }
        }
      });
    }

    test('renders in both themes and keeps the switch working', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });

      // The theme is asserted through `color-scheme` and the `--background`
      // token rather than through the class list: the class only carries an
      // EXPLICIT choice, while the operating system's preference is answered by
      // a media query that adds no class at all. Reading the class alone would
      // therefore prove nothing about the system default.
      const themeState = () =>
        page.evaluate(() => {
          const root = document.documentElement;
          return {
            className: root.className,
            colorScheme: getComputedStyle(root).colorScheme,
            background: getComputedStyle(root).getPropertyValue('--background').trim(),
          };
        });

      // The system preference is the default, so dark must arrive without the
      // visitor touching anything — and without a script: no theme class is
      // present, only the media query.
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto(`/${locale}`, { waitUntil: 'domcontentloaded' });
      const systemDark = await themeState();
      expect(systemDark.colorScheme, 'a dark system did not reach the dark palette').toBe('dark');
      expect(systemDark.className, 'the system default must not claim an explicit choice').not.toMatch(
        /(^|\s)(dark|light)(\s|$)/,
      );

      await page.emulateMedia({ colorScheme: 'light' });
      await expect.poll(async () => (await themeState()).colorScheme).toBe('light');
      const systemLight = await themeState();
      expect(systemLight.background, 'both system palettes resolved to the same token').not.toBe(
        systemDark.background,
      );

      const themeSelect = page.locator('select').filter({ has: page.locator('option[value="system"]') });
      await expect(themeSelect).toBeEnabled();

      // An explicit choice has to beat the operating system, be visible in the
      // class list, and survive a reload: the reload is the whole point of
      // storing it in a cookie the server can read.
      await themeSelect.selectOption('dark');
      await expect.poll(async () => (await themeState()).className).toMatch(/(^|\s)dark(\s|$)/);
      expect((await themeState()).background, 'the explicit dark palette differs from the system one').toBe(
        systemDark.background,
      );

      await page.reload({ waitUntil: 'domcontentloaded' });
      const reloaded = await themeState();
      expect(reloaded.className, 'the chosen theme did not survive a reload').toMatch(/(^|\s)dark(\s|$)/);
      expect(reloaded.colorScheme).toBe('dark');

      // The other direction: an explicit light choice must win against a dark
      // operating system, which is what the `.light` guard in the variant is
      // for.
      await page.emulateMedia({ colorScheme: 'dark' });
      await themeSelect.selectOption('light');
      await expect.poll(async () => (await themeState()).colorScheme).toBe('light');
      const explicitLight = await themeState();
      expect(explicitLight.className).toMatch(/(^|\s)light(\s|$)/);
      expect(explicitLight.background).not.toBe(systemDark.background);

      // Back to the system: the class disappears, the cookie is deleted and the
      // dark operating system decides again.
      await themeSelect.selectOption('system');
      await expect.poll(async () => (await themeState()).colorScheme).toBe('dark');
      expect((await themeState()).className).not.toMatch(/(^|\s)(dark|light)(\s|$)/);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, 'the dark theme overflows the mobile viewport').toBeLessThanOrEqual(1);
    });
  });
}
