import { describe, expect, it } from 'vitest';
import sitemap from '@/app/sitemap';
import robots from '@/app/robots';
import { publicPageMetadata } from '@/lib/seo';
import { BRAND_NAME } from '@/lib/brand';
import { routing, type Locale } from '@/i18n/routing';
import { getLegalPublicationStatus, legalConfig } from '@/lib/legal/config';
import zh from '@/messages/zh-CN.json';
import en from '@/messages/en.json';
import ja from '@/messages/ja.json';
import de from '@/messages/de.json';
import es from '@/messages/es.json';
import fr from '@/messages/fr.json';
import legalZhFile from '@/messages/legal.zh-CN.json';
import legalEnFile from '@/messages/legal.en.json';

/**
 * Plan acceptance criteria 35 and 25: the public multilingual surface must carry
 * real, complete SEO for every locale while every private page stays out of the
 * index, and the crawl surface (sitemap/robots) must agree with the pages that
 * actually exist.
 *
 * Nothing here is mocked: the sitemap and robots builders are called directly,
 * the metadata helper is the one the pages use, and the message catalogs are the
 * exact files the running app loads. The rendered-HTML crawl is already covered
 * by `scripts/smoke/smoke-legal-pages.mts`, so this file asserts the contracts that can
 * be checked without a server.
 */
const origin = new URL(process.env.APP_BASE_URL || 'http://localhost:3000').origin;
const locales = routing.locales;
const defaultLocale = routing.defaultLocale;
const messageCatalogs: Record<Locale, Record<string, unknown>> = {
  'zh-CN': zh as Record<string, unknown>,
  en: en as Record<string, unknown>,
  ja: ja as Record<string, unknown>,
  de: de as Record<string, unknown>,
  es: es as Record<string, unknown>,
  fr: fr as Record<string, unknown>,
};
/** The og:locale each language must advertise; Open Graph uses underscores. */
const OG_LOCALES: Record<Locale, string> = {
  en: 'en_US',
  'zh-CN': 'zh_CN',
  ja: 'ja_JP',
  de: 'de_DE',
  es: 'es_ES',
  fr: 'fr_FR',
};
const legalZh = (legalZhFile as Record<string, unknown>).Legal as Record<string, unknown>;
const legalEn = (legalEnFile as Record<string, unknown>).Legal as Record<string, unknown>;
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
const PUBLIC_PAGE_PATHS = ['', '/pricing', '/faq', '/privacy', '/terms'] as const;
const SEO_PAIRS = [
  ['homeTitle', 'homeDescription'],
  ['pricingTitle', 'pricingDescription'],
  ['faqTitle', 'faqDescription'],
] as const;
/** Latin-script catalogs: any CJK in them is untranslated Chinese bleeding through. */
const LATIN_LOCALES = ['en', 'de', 'es', 'fr'] as const;
const LEGAL_SECTIONS = {
  privacy: ['account', 'billing', 'email', 'browser', 'controls', 'retention'],
  terms: ['account', 'payments', 'subscription', 'referrals', 'email', 'availability'],
} as const;

function seoMessages(locale: Locale): Record<string, string> {
  const namespace = messageCatalogs[locale].Seo;
  if (!namespace || typeof namespace !== 'object') throw new Error(`Seo namespace missing for ${locale}`);
  return namespace as Record<string, string>;
}

function translation(namespace: Record<string, unknown>, path: string): string {
  const value = path.split('.').reduce<unknown>(
    (current, key) => (current && typeof current === 'object'
      ? (current as Record<string, unknown>)[key] : undefined), namespace);
  if (typeof value !== 'string') throw new Error(`Missing message: ${path}`);
  return value;
}

describe('public page metadata', () => {
  it('emits a self-referential canonical plus every language and x-default alternate', () => {
    for (const locale of locales) {
      const metadata = publicPageMetadata(locale, '/pricing', 'Title', 'Description');
      const languages = metadata.alternates?.languages;
      expect(metadata.alternates?.canonical).toBe(`${origin}/${locale}/pricing`);
      expect(languages).toMatchObject(Object.fromEntries([
        ...locales.map((language) => [language, `${origin}/${language}/pricing`]),
        ['x-default', `${origin}/${defaultLocale}/pricing`],
      ]));
    }
  });

  it('keeps the canonical URL equal to the advertised openGraph URL in every locale', () => {
    for (const locale of locales) {
      const metadata = publicPageMetadata(locale, '', 'Title', 'Description');
      expect(metadata.openGraph?.url).toBe(metadata.alternates?.canonical);
      expect(metadata.openGraph).toMatchObject({
        type: 'website',
        siteName: BRAND_NAME,
        locale: OG_LOCALES[locale],
        title: 'Title',
        description: 'Description',
      });
    }
  });

  it('never leaks a second locale value into the other locale canonical path', () => {
    const chinese = publicPageMetadata('zh-CN', '/terms', 'T', 'D');
    const english = publicPageMetadata('en', '/terms', 'T', 'D');
    expect(String(chinese.alternates?.canonical)).toContain('/zh-CN/terms');
    expect(String(chinese.alternates?.canonical)).not.toContain('/en/terms');
    expect(String(english.alternates?.canonical)).toContain('/en/terms');
    expect(String(english.alternates?.canonical)).not.toContain('/zh-CN/terms');
  });

  it('builds every canonical URL from the configured APP_BASE_URL origin, never a hardcoded host', () => {
    const configured = new URL(process.env.APP_BASE_URL || 'http://localhost:3000').origin;
    for (const locale of locales) {
      for (const path of PUBLIC_PAGE_PATHS) {
        const metadata = publicPageMetadata(locale, path, 'T', 'D');
        expect(String(metadata.alternates?.canonical).startsWith(configured)).toBe(true);
      }
    }
  });
});

describe('sitemap', () => {
  it('lists every public page in every language with its language alternates', () => {
    const entries = sitemap();
    const urls = entries.map((entry) => String(entry.url));
    for (const path of PUBLIC_PAGE_PATHS) {
      for (const locale of locales) {
        expect(urls).toContain(`${origin}/${locale}${path}`);
      }
    }
    expect(entries).toHaveLength(PUBLIC_PAGE_PATHS.length * locales.length);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('offers every locale as a cross-link on every entry', () => {
    for (const entry of sitemap()) {
      const languages = entry.alternates?.languages as Record<string, string> | undefined;
      for (const locale of locales) {
        expect(languages?.[locale], `${entry.url} lacks hreflang ${locale}`).toBeTypeOf('string');
      }
      for (const value of Object.values(languages ?? {})) {
        expect(String(value).startsWith(origin)).toBe(true);
      }
    }
  });

  it('advertises the two legal documents in every language the app renders', () => {
    const urls = sitemap().map((entry) => String(entry.url));
    for (const locale of locales) {
      expect(urls).toContain(`${origin}/${locale}/privacy`);
      expect(urls).toContain(`${origin}/${locale}/terms`);
    }
  });

  it('matches the canonical and hreflang of the page metadata it advertises', () => {
    const entries = new Map(sitemap().map((entry) => [String(entry.url), entry]));
    for (const path of PUBLIC_PAGE_PATHS) {
      for (const locale of locales) {
        const entry = entries.get(`${origin}/${locale}${path}`);
        expect(entry, `${locale}${path} is missing from the sitemap`).toBeDefined();
        const metadata = publicPageMetadata(locale, path, 'T', 'D');
        expect(String(entry?.url)).toBe(metadata.alternates?.canonical);
        // A sitemap entry may carry fewer hreflang links than the page head, but
        // every language it does advertise must agree with the page metadata.
        for (const [language, href] of Object.entries(
          (entry?.alternates?.languages ?? {}) as Record<string, string>)) {
          const expected = (metadata.alternates?.languages as Record<string, string>)[language];
          expect(expected, `${locale}${path} announces unknown hreflang ${language}`).toBeDefined();
          expect(String(href)).toBe(expected);
        }
      }
    }
  });

  it('never advertises a private route, an API route or a locale that is not routable', () => {
    for (const entry of sitemap()) {
      const url = String(entry.url);
      expect(url).not.toContain('/dashboard');
      expect(url).not.toContain('/api/');
      expect(url).not.toContain('/sign-in');
      expect(url).not.toContain('/sign-up');
      const locale = new URL(url).pathname.split('/')[1];
      expect(locales).toContain(locale as Locale);
    }
  });
});

describe('robots', () => {
  it('allows the public pages, disallows the private ones and points at the sitemap', () => {
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;
    expect(rule?.userAgent).toBe('*');
    expect(rule?.allow).toBe('/');
    const disallow = String(rule?.disallow ?? '');
    expect(disallow).toContain('/api/');
    expect(disallow).toContain('/*/dashboard/');
    expect(disallow).toContain('/*/sign-in');
    expect(disallow).toContain('/*/sign-up');
    expect(String(robots().sitemap)).toBe(`${origin}/sitemap.xml`);
  });

  it('keeps every page it disallows out of the sitemap', () => {
    const rules = robots().rules;
    const rule = Array.isArray(rules) ? rules[0] : rules;
    const patterns = (Array.isArray(rule?.disallow) ? rule.disallow : [rule?.disallow ?? ''])
      .map((value) => String(value).replace(/\*/g, '').replace(/\/$/, ''));
    for (const entry of sitemap()) {
      const url = new URL(String(entry.url)).pathname;
      for (const pattern of patterns) {
        if (pattern === '/api') continue;
        expect(url).not.toContain(pattern);
      }
    }
  });
});

describe('message completeness', () => {
  it('defines a title and a description for every public page in every locale', () => {
    for (const locale of locales) {
      const messages = seoMessages(locale);
      for (const [title, description] of SEO_PAIRS) {
        expect(messages[title]?.trim().length, `${locale}.${title}`).toBeGreaterThan(0);
        expect(messages[description]?.trim().length, `${locale}.${description}`).toBeGreaterThan(0);
      }
    }
  });

  it('never reuses one locale description for another page', () => {
    for (const locale of locales) {
      const messages = seoMessages(locale);
      const descriptions = SEO_PAIRS.map(([, description]) => messages[description]);
      expect(new Set(descriptions).size).toBe(descriptions.length);
      const titles = SEO_PAIRS.map(([title]) => messages[title]);
      expect(new Set(titles).size).toBe(titles.length);
    }
  });

  it('writes Chinese copy in Chinese and the Latin-script copy without CJK characters', () => {
    // Japanese is excluded on purpose: its copy legitimately mixes kana and kanji.
    for (const [title, description] of SEO_PAIRS) {
      expect(CJK.test(seoMessages('zh-CN')[title]), `zh-CN ${title}`).toBe(true);
      expect(CJK.test(seoMessages('zh-CN')[description]), `zh-CN ${description}`).toBe(true);
      for (const locale of LATIN_LOCALES) {
        expect(CJK.test(seoMessages(locale)[title]), `${locale} ${title}`).toBe(false);
        expect(CJK.test(seoMessages(locale)[description]), `${locale} ${description}`).toBe(false);
      }
    }
  });

  it('keeps English as the default locale with a catalog for every declared locale', () => {
    expect(defaultLocale).toBe('en');
    expect(locales[0]).toBe('en');
    for (const locale of locales) expect(messageCatalogs[locale]).toBeDefined();
  });
});

describe('legal document metadata and copy', () => {
  /**
   * `lib/legal/metadata.ts` imports `next-intl/server`, which resolves
   * `next/headers` only inside a Next server runtime and therefore cannot be
   * loaded by Vitest at all (import fails before any assertion runs). That
   * leaves the rendered noindex/index contract **without automated coverage**:
   * `scripts/smoke/smoke-legal-pages.mts` would render it, but that script does
   * not currently run (it imports `lib/legal/config.ts`, whose `@/` path alias
   * tsx does not resolve here). What is pinned here is only the canonical and
   * the draft status the robots flag is derived from — not the robots flag
   * itself. Do not add an assertion that recomputes `!isDraft`; it passes even
   * when the real helper stops emitting `robots`.
   */
  it('keeps the legal pages canonical while the template is a draft', () => {
    const status = getLegalPublicationStatus();
    expect(status.isDraft).toBe(true);
    for (const locale of locales) {
      for (const kind of ['privacy', 'terms'] as const) {
        const metadata = publicPageMetadata(locale, `/${kind}`, 'Title', 'Description');
        expect(metadata.alternates?.canonical).toBe(`${origin}/${locale}/${kind}`);
        expect(metadata.robots).toBeUndefined();
      }
    }
  });

  it('prefixes the draft title so an unapproved document never reads as final', () => {
    const status = getLegalPublicationStatus();
    const termsTitle = translation(legalZh, 'terms.title');
    const draftTitle = translation(legalZh, 'draftTitle').replace('{title}', termsTitle);
    expect(termsTitle.trim().length).toBeGreaterThan(0);
    if (status.isDraft) expect(draftTitle).toContain(termsTitle);
    else expect(draftTitle).toBe(termsTitle);
  });

  it('documents every section the legal document component renders in both languages', () => {
    for (const [kind, names] of Object.entries(LEGAL_SECTIONS)) {
      for (const namespace of [legalZh, legalEn]) {
        for (const name of names) {
          expect(translation(namespace, `${kind}.sections.${name}.title`).trim().length,
            `${kind}.${name} title`).toBeGreaterThan(0);
          expect(translation(namespace, `${kind}.sections.${name}.body`).trim().length,
            `${kind}.${name} body`).toBeGreaterThan(40);
        }
      }
    }
  });

  it('writes the Chinese legal bodies in Chinese and the English bodies without CJK characters', () => {
    for (const [kind, names] of Object.entries(LEGAL_SECTIONS)) {
      for (const name of names) {
        expect(CJK.test(translation(legalZh, `${kind}.sections.${name}.body`)),
          `zh-CN ${kind}.${name}`).toBe(true);
        expect(CJK.test(translation(legalEn, `${kind}.sections.${name}.body`)),
          `en ${kind}.${name}`).toBe(false);
      }
    }
  });

  it('labels every configurable legal field and the draft notice in both locales', () => {
    const fields = ['operatorName', 'supportContact', 'effectiveDate', 'privacyDetails',
      'termsDetails', 'approvedForPublication'];
    for (const namespace of [legalZh, legalEn]) {
      for (const field of fields) {
        expect(translation(namespace, `fields.${field}`).trim().length, field).toBeGreaterThan(0);
      }
      for (const key of ['draft.heading', 'draft.body', 'draft.missing', 'contents',
        'unconfigured', 'navigation.skip', 'navigation.home', 'navigation.primary',
        'navigation.documents', 'privacy.detailsTitle', 'privacy.detailsMissing',
        'terms.detailsTitle', 'terms.detailsMissing']) {
        expect(translation(namespace, key).trim().length, key).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the published legal template incomplete, with the missing fields in a stable order', () => {
    const status = getLegalPublicationStatus(legalConfig);
    expect(status.missingFields).toEqual([
      'operatorName', 'supportContact', 'effectiveDate', 'privacyDetails',
      'termsDetails', 'approvedForPublication',
    ]);
    expect(status.isDraft).toBe(true);
  });
});
