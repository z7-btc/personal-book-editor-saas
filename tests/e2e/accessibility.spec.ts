import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Accessibility at the browser boundary (plan AC 33, plan section 8 "Axe/WCAG AA").
 *
 * axe-core is run against the real dev server over the public surface in every
 * locale and, for the entry pages, at a mobile viewport, with the WCAG 2.0/2.1
 * A + AA rule set. The assertion is that the scan finds NOTHING: an allowlist of
 * accepted violations is a list of accepted defects, and every violation this
 * surface has produced so far was small enough to remove rather than excuse.
 *
 * Only public pages are scanned, so the spec needs no account, no third party
 * and no fixture. The authenticated dashboard is covered structurally by
 * `tests/referral-ui.test.ts` (keyboard reachability, focus order, ARIA live
 * regions, 44px targets, masked payout account); it is not scanned here because
 * it would need a signed-in browser and the referral features are off by
 * default in this environment.
 */
// Playwright does not resolve this project's `@/` path alias, so the list is
// spelled out here; tests/i18n.test.ts asserts it matches i18n/routing.ts.
const locales = ['en', 'zh-CN', 'ja', 'de', 'es', 'fr'] as const;
const publicPaths = ['', '/pricing', '/faq', '/privacy', '/terms', '/sign-in', '/sign-up'] as const;
const mobilePaths = ['', '/pricing', '/sign-up'] as const;
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Every violation, flattened into one line per finding so a failure names its page and node. */
async function scan(page: Page, url: string): Promise<string[]> {
  await page.goto(url);
  await expect(page.locator('body')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  return results.violations.map(
    (violation) =>
      `${violation.id} [${violation.impact ?? 'unknown'}] ${violation.help} -> ${violation.nodes
        .map((node) => node.target.join(' '))
        .join(', ')}`,
  );
}

for (const locale of locales) {
  test(`the ${locale} public pages pass a WCAG A/AA axe scan`, async ({ page }) => {
    for (const path of publicPaths) {
      const url = `/${locale}${path}`;
      const violations = await scan(page, url);
      expect(violations, `${url} must not report an accessibility violation`).toEqual([]);
    }
  });

  test(`the ${locale} entry pages pass the same scan at a mobile viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of mobilePaths) {
      const url = `/${locale}${path}`;
      const violations = await scan(page, url);
      expect(violations, `${url} at 390x844 must not report an accessibility violation`).toEqual([]);
    }
  });
}

/**
 * The viewport meta is asserted by name as well as by scan, because WCAG 1.4.4
 * (resize text) is the one requirement a page can lose by adding a single
 * attribute, and `maximumScale: 1` used to be set here. A reader must always be
 * able to pinch-zoom.
 */
for (const locale of locales) {
  test(`the ${locale} pages let the reader zoom`, async ({ page }) => {
    await page.goto(`/${locale}`);
    const content = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(content ?? '').toContain('width=device-width');
    expect(content ?? '').not.toMatch(/maximum-scale|user-scalable\s*=\s*no/i);
  });
}
