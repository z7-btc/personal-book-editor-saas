import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';

/**
 * Locale routing and message-bundle contract (plan acceptance criteria 33 and 35).
 *
 * The bundle assertions run against the exact files `i18n/request.ts` loads, the
 * namespaces are discovered from the application source instead of a
 * hand-maintained list, and the locale-resolution assertions execute the real
 * Next.js middleware (`proxy.ts`) when the Vitest module loader can load
 * next-intl (see HARNESS_LIMITATION).
 */

const repoRoot = process.cwd();
const LOCALES = ['en', 'zh-CN', 'ja', 'de', 'es', 'fr'] as const;
type Bundle = Record<string, unknown>;

const HARNESS_LIMITATION =
  'next-intl is externalized by Vitest and its ESM build imports the extensionless specifier '
  + '"next/server"/"next/navigation", which Node cannot resolve (next\'s exports map does not expose them). '
  + 'Add `test: { server: { deps: { inline: [\'next-intl\'] } } }` to vitest.config.mts to execute this check.';

function loadFile(relativePath: string): Bundle {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as Bundle;
}

function loadBundle(locale: string): Bundle {
  return loadFile(join('messages', `${locale}.json`));
}

function flattenLeaves(value: unknown, prefix = ''): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return { [prefix]: value };
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>(
    (leaves, [key, child]) => Object.assign(leaves, flattenLeaves(child, prefix ? `${prefix}.${key}` : key)),
    {},
  );
}

function leaf(bundle: Bundle, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>(
    (current, part) => (current && typeof current === 'object'
      ? (current as Record<string, unknown>)[part]
      : undefined),
    bundle,
  );
}

function sourceFiles(directory: string): string[] {
  const entries = readdirSync(join(repoRoot, directory), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return /\.tsx?$/.test(entry.name) ? [child] : [];
  });
}

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

const zh = loadBundle('zh-CN');
const en = loadBundle('en');
const allBundles = LOCALES.map((locale) => [locale, loadBundle(locale)] as const);

describe('message bundles', () => {
  it('ships English as the default locale with an explicit prefix for both locales', async () => {
    const { routing } = await import('@/i18n/routing');
    expect(routing.locales).toEqual([...LOCALES]);
    expect(routing.defaultLocale).toBe('en');
    expect(routing.localePrefix).toBe('always');
  });

  it('exposes exactly the same key set in every locale', () => {
    const enKeys = Object.keys(flattenLeaves(en)).sort();
    expect(enKeys.length).toBeGreaterThan(250);
    for (const [locale, bundle] of allBundles) {
      const keys = Object.keys(flattenLeaves(bundle)).sort();
      expect(keys.filter((key) => !enKeys.includes(key)), `${locale} has keys English lacks`).toEqual([]);
      expect(enKeys.filter((key) => !keys.includes(key)), `${locale} is missing keys English has`).toEqual([]);
    }
  });

  it('has no empty or non-string message in either locale', () => {
    for (const [locale, bundle] of allBundles) {
      const empties = Object.entries(flattenLeaves(bundle))
        .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
        .map(([key]) => `${locale}:${key}`);
      expect(empties).toEqual([]);
    }
  });

  it('translates every namespace that application code asks for', () => {
    const namespaces = new Map<string, string[]>();
    const record = (namespace: string, file: string) => {
      namespaces.set(namespace, [...(namespaces.get(namespace) ?? []), file]);
    };
    for (const file of [...sourceFiles('app'), ...sourceFiles('components'), ...sourceFiles('lib')]) {
      const source = read(file);
      for (const match of source.matchAll(/(?:useTranslations|getTranslations)\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
        record(match[1], file);
      }
      for (const match of source.matchAll(/namespace:\s*['"]([A-Za-z0-9_]+)['"]/g)) {
        record(match[1], file);
      }
    }
    // Guard against a regex that silently stops matching after a refactor.
    expect(namespaces.size).toBeGreaterThanOrEqual(8);
    const missing = [...namespaces.entries()]
      .flatMap(([namespace, files]) => allBundles
        .filter(([, bundle]) => typeof leaf(bundle, namespace) !== 'object')
        .map(([locale]) => `${locale}:${namespace} (used by ${[...new Set(files)].join(', ')})`));
    expect(missing).toEqual([]);
  });

  it('translates every activity event type and category the feed can emit', async () => {
    const { activityEventTypes } = await import('@/lib/activity/events');
    expect(activityEventTypes.length).toBeGreaterThanOrEqual(14);
    const missing: string[] = [];
    for (const type of activityEventTypes) {
      for (const field of ['title', 'description'] as const) {
        for (const [locale, bundle] of allBundles) {
          const value = leaf(bundle, `Activity.events.${type}.${field}`);
          if (typeof value !== 'string' || value.trim() === '') {
            missing.push(`${locale}:Activity.events.${type}.${field}`);
          }
        }
      }
    }
    for (const category of ['account', 'security', 'billing'] as const) {
      for (const [locale, bundle] of allBundles) {
        const value = leaf(bundle, `Activity.categories.${category}`);
        if (typeof value !== 'string' || value.trim() === '') {
          missing.push(`${locale}:Activity.categories.${category}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps every standalone bundle symmetrical and merged into the loaded bundles', () => {
    const standalone = readdirSync(join(repoRoot, 'messages'))
      .filter((file) => /^[a-z-]+\.(zh-CN|en)\.json$/.test(file));
    expect(standalone.length).toBeGreaterThan(0);
    const names = [...new Set(standalone.map((file) => file.split('.')[0]))];
    for (const name of names) {
      const zhSide = loadFile(join('messages', `${name}.zh-CN.json`));
      const enSide = loadFile(join('messages', `${name}.en.json`));
      expect(Object.keys(flattenLeaves(zhSide)).sort()).toEqual(Object.keys(flattenLeaves(enSide)).sort());
      // A bundle that no page can reach is a translation that never renders, and a
      // merged copy that drifted from its source renders text nobody reviewed.
      for (const namespace of Object.keys(zhSide)) {
        const zhMerged = leaf(zh, namespace);
        const enMerged = leaf(en, namespace);
        expect(typeof zhMerged, `messages/zh-CN.json lacks ${namespace} from ${name}.zh-CN.json`).toBe('object');
        expect(typeof enMerged, `messages/en.json lacks ${namespace} from ${name}.en.json`).toBe('object');
        expect(flattenLeaves(zhMerged),
          `messages/zh-CN.json renders a stale ${namespace}; re-merge ${name}.zh-CN.json into it`)
          .toEqual(flattenLeaves(zhSide[namespace]));
        expect(flattenLeaves(enMerged),
          `messages/en.json renders a stale ${namespace}; re-merge ${name}.en.json into it`)
          .toEqual(flattenLeaves(enSide[namespace]));
      }
    }
  });

  it('loads each locale from its own bundle and no other', () => {
    // i18n/request.ts loads exactly one file per locale; every extra bundle must
    // therefore be merged into that file or it never reaches the UI.
    const source = read('i18n/request.ts');
    expect(source).toMatch(/hasLocale\(routing\.locales, requested\)/);
    expect(source).toMatch(/notFound\(\)/);
    // Compare the key→file mapping, not just the set of files: pointing `ja` at
    // de.json would compile, keep the sorted file list identical, and serve
    // German to Japanese readers.
    const loaders = new Map(
      [...source.matchAll(/(?:'([\w-]+)'|(\w+)):\s*\(\)\s*=>\s*import\('([^']+)'\)/g)]
        .map((match) => [match[1] ?? match[2], match[3]] as const),
    );
    // Equality in both directions: a missing loader makes a supported locale
    // crash on load, and an extra loader ships a bundle nobody can reach.
    expect([...loaders.keys()].sort()).toEqual([...LOCALES].sort());
    for (const locale of LOCALES) {
      expect(loaders.get(locale), locale).toBe(`../messages/${locale}.json`);
    }
  });

  it('keeps the Better Auth locale list aligned with the routing table', () => {
    // auth.config.ts repeats the list literal for the schema generator, which
    // loads it without this project's path aliases; without this check a new
    // locale would be routable but rejected when saved to the account.
    const source = read('auth.config.ts');
    const match = source.match(/preferredLocale:\s*\{[\s\S]*?type:\s*\[([^\]]+)\]/);
    expect(match).not.toBeNull();
    const listed = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
    expect(listed.sort()).toEqual([...LOCALES].sort());
  });

  it('runs the browser matrix over every routing locale', () => {
    // Playwright cannot resolve the `@/` alias, so these specs repeat the list;
    // a locale missing here ships without any real-browser coverage.
    for (const file of ['tests/e2e/responsive.spec.ts', 'tests/e2e/accessibility.spec.ts']) {
      const match = read(file).match(/const locales = \[([^\]]+)\] as const/);
      expect(match, `${file} has no locales list`).not.toBeNull();
      const listed = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
      expect(listed.sort(), file).toEqual([...LOCALES].sort());
    }
  });

  it('exposes the language label the switcher renders', () => {
    for (const [locale, bundle] of allBundles) {
      expect(typeof leaf(bundle, 'Nav.language'), locale).toBe('string');
      expect(String(leaf(bundle, 'Nav.language')).trim(), locale).not.toBe('');
    }
  });
});

describe('locale resolution through the Next.js middleware', () => {
  interface Runtime {
    proxy: (request: NextRequest) => Response;
    parseRequest: (url: string, init?: { cookie?: string; acceptLanguage?: string }) => NextRequest;
  }
  let runtime: Runtime | null = null;

  beforeAll(async () => {
    try {
      const { NextRequest: NextRequestClass } = await import('next/server');
      const { default: proxy } = await import('@/proxy');
      runtime = {
        proxy: proxy as unknown as Runtime['proxy'],
        parseRequest: (url, init = {}) => new NextRequestClass(url, {
          headers: {
            ...(init.cookie ? { cookie: init.cookie } : {}),
            ...(init.acceptLanguage ? { 'accept-language': init.acceptLanguage } : {}),
          },
        }),
      };
    } catch {
      runtime = null;
    }
  });

  const target = (response: Response) => new URL(response.headers.get('location') ?? '', 'http://localhost:3000');

  it('redirects an unprefixed path to the default locale en when no locale signal exists', async (context) => {
    if (!runtime) return context.skip(HARNESS_LIMITATION);
    const response = await runtime.proxy(runtime.parseRequest('http://localhost:3000/dashboard/general'));
    expect(response.status).toBe(307);
    expect(target(response).pathname).toBe('/en/dashboard/general');
  });

  it('falls back to en when Accept-Language names only unsupported languages', async (context) => {
    if (!runtime) return context.skip(HARNESS_LIMITATION);
    // Russian and Thai are deliberately outside routing.locales; using a shipped
    // locale here would assert the opposite of what this test claims.
    const response = await runtime.proxy(runtime.parseRequest('http://localhost:3000/pricing', {
      acceptLanguage: 'ru-RU,ru;q=0.9,th;q=0.8',
    }));
    expect(response.status).toBe(307);
    expect(target(response).pathname).toBe('/en/pricing');
  });

  it('honours Accept-Language when no locale cookie is present', async (context) => {
    if (!runtime) return context.skip(HARNESS_LIMITATION);
    const response = await runtime.proxy(runtime.parseRequest('http://localhost:3000/pricing', {
      acceptLanguage: 'en-US,en;q=0.9',
    }));
    expect(response.status).toBe(307);
    expect(target(response).pathname).toBe('/en/pricing');
  });

  it('routes a visitor whose browser asks for a newly added locale', async (context) => {
    if (!runtime) return context.skip(HARNESS_LIMITATION);
    for (const [acceptLanguage, expected] of [
      ['ja-JP,ja;q=0.9', '/ja/pricing'],
      ['de-DE,de;q=0.9', '/de/pricing'],
      ['es-MX,es;q=0.9', '/es/pricing'],
      ['fr-CA,fr;q=0.9', '/fr/pricing'],
    ] as const) {
      const response = await runtime.proxy(runtime.parseRequest('http://localhost:3000/pricing', { acceptLanguage }));
      expect(response.status, acceptLanguage).toBe(307);
      expect(target(response).pathname, acceptLanguage).toBe(expected);
    }
  });

  it('lets the locale cookie win over Accept-Language', async (context) => {
    if (!runtime) return context.skip(HARNESS_LIMITATION);
    const response = await runtime.proxy(runtime.parseRequest('http://localhost:3000/pricing', {
      cookie: 'NEXT_LOCALE=en',
      acceptLanguage: 'zh-CN,zh;q=0.9',
    }));
    expect(response.status).toBe(307);
    expect(target(response).pathname).toBe('/en/pricing');
  });

  it('rewrites an already-prefixed path in the cookie locale without redirecting', async (context) => {
    if (!runtime) return context.skip(HARNESS_LIMITATION);
    const response = await runtime.proxy(runtime.parseRequest('http://localhost:3000/en/pricing', {
      cookie: 'NEXT_LOCALE=en',
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('redirects an unprefixed path to the locale named by the cookie', async (context) => {
    if (!runtime) return context.skip(HARNESS_LIMITATION);
    const response = await runtime.proxy(runtime.parseRequest('http://localhost:3000/pricing', {
      cookie: 'NEXT_LOCALE=de',
    }));
    expect(response.status).toBe(307);
    expect(target(response).pathname).toBe('/de/pricing');
  });

  it('lets an explicit prefix beat the locale cookie and rewrites the cookie to match', async (context) => {
    if (!runtime) return context.skip(HARNESS_LIMITATION);
    // Verified against the real dev server on 2026-11-16: a prefixed URL is
    // taken at its word and NEXT_LOCALE is rewritten to agree with it. A
    // redirect here would overrule a visitor who typed the locale into the
    // address bar or followed a shared link. This replaces an earlier
    // assertion that expected a 307 — it had never executed (see
    // HARNESS_LIMITATION), so the wrong expectation went unnoticed.
    const response = await runtime.proxy(runtime.parseRequest('http://localhost:3000/en/pricing', {
      cookie: 'NEXT_LOCALE=zh-CN',
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toContain('NEXT_LOCALE=en');
  });

  it('varies the response on Cookie and Accept-Language so caches cannot mix locales', async (context) => {
    if (!runtime) return context.skip(HARNESS_LIMITATION);
    const response = await runtime.proxy(runtime.parseRequest('http://localhost:3000/pricing', {
      acceptLanguage: 'en-US,en;q=0.9',
    }));
    const vary = (response.headers.get('vary') ?? '')
      .split(',').map((field) => field.trim().toLowerCase()).filter(Boolean);
    expect(vary).toContain('cookie');
    expect(vary).toContain('accept-language');
  });

  it('wires the middleware from the shared routing table and keeps non-page requests out', () => {
    const source = read('proxy.ts');
    expect(source).toMatch(/createMiddleware\(routing\)/);
    // The matcher must skip API routes, Next internals and any file request, so
    // that only page navigations reach locale negotiation.
    expect(source).toMatch(/matcher: '\/\(\(\?!api\|_next\|_vercel\|\.\*\\\\\.\.\*\)\.\*\)'/);
    expect(source).toMatch(/fields\.add\('Cookie'\)/);
    expect(source).toMatch(/fields\.add\('Accept-Language'\)/);
    expect(source).toMatch(/if \(vary !== '\*'\)/);
  });
});

describe('language switching', () => {
  it('prefixes the target locale through the navigation helper the switcher uses', async (context) => {
    let getPathname: (config: { locale: string; href: string }) => string;
    try {
      ({ getPathname } = await import('@/i18n/navigation') as unknown as typeof import('@/i18n/navigation'));
    } catch {
      return context.skip(HARNESS_LIMITATION);
    }
    expect(getPathname({ locale: 'en', href: '/pricing' })).toBe('/en/pricing');
    expect(getPathname({ locale: 'zh-CN', href: '/dashboard/general' })).toBe('/zh-CN/dashboard/general');
    expect(getPathname({ locale: 'ja', href: '/pricing' })).toBe('/ja/pricing');
  });

  it('offers every routing locale in the switcher', async () => {
    const { routing } = await import('@/i18n/routing');
    const source = read('components/language-switcher.tsx');
    const offered = [...source.matchAll(/value:\s*'([^']+)'/g)].map((match) => match[1]);
    // A locale the router serves but the switcher omits is unreachable for every
    // visitor who cannot read the default language.
    expect(offered.sort()).toEqual([...routing.locales].sort());
  });

  it('offers every routing locale as an email language on the account page', async () => {
    // The email-language picker repeats the list a third time. A locale missing
    // here is routable but impossible to choose for letters sent by the app.
    const { routing } = await import('@/i18n/routing');
    const source = read('app/[locale]/(dashboard)/dashboard/general/general-client.tsx');
    const offered = [...source.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.sort()).toEqual([...routing.locales].sort());
  });

  /**
   * No DOM harness is installed in this repository (jsdom, happy-dom and
   * @testing-library/* are absent) and components/** is outside this task's write
   * scope, so the switcher's behaviour is pinned at source level: the switched URL
   * must be the localized pathname plus the live query string and fragment, and
   * the locale must travel as a routing option rather than as a raw URL.
   */
  it('keeps the current query string and fragment when switching locale', () => {
    const source = read('components/language-switcher.tsx');
    expect(source).toMatch(/from '@\/i18n\/navigation'/);
    expect(source).toMatch(/usePathname\(\)/);
    expect(source).toMatch(/router\.replace\(\s*`\$\{pathname\}\$\{window\.location\.search\}\$\{window\.location\.hash\}`/);
    expect(source).toMatch(/\{ locale: option\.value \}/);
    expect(source).toMatch(/option\.value === locale/);
    expect(source).toMatch(/\{current\.label\}/);
    expect(source).toMatch(/aria-label=\{t\('language'\)\}/);
  });

  it('exports the localized navigation helpers from the shared routing table', () => {
    const source = read('i18n/navigation.ts');
    expect(source).toMatch(/createNavigation\(routing\)/);
    for (const helper of ['Link', 'redirect', 'usePathname', 'useRouter', 'getPathname']) {
      expect(source).toContain(helper);
    }
  });

  it('mounts the switcher on both public and dashboard shells', () => {
    const mounted = [...sourceFiles('app'), ...sourceFiles('components')]
      .filter((file) => read(file).includes('<LanguageSwitcher'));
    expect(mounted.length).toBeGreaterThanOrEqual(2);
  });
});
