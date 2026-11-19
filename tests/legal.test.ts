import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  getLegalPublicationStatus, getLegalSupportContact, legalConfig,
  type LegalConfig, type LegalDocumentKind, type LegalMissingField,
} from '@/lib/legal/config';
import { routing, type Locale } from '@/i18n/routing';
import legalZhFile from '@/messages/legal.zh-CN.json';
import legalEnFile from '@/messages/legal.en.json';
import zhBundle from '@/messages/zh-CN.json';
import enBundle from '@/messages/en.json';
import jaBundle from '@/messages/ja.json';
import deBundle from '@/messages/de.json';
import esBundle from '@/messages/es.json';
import frBundle from '@/messages/fr.json';

/**
 * Plan acceptance criteria 34, 35 and 25 (legal half): the published template
 * must stay an explicit draft until an operator supplies verified public facts,
 * and nothing in the legal surface may invent a date, an operator name or a
 * contact link.
 *
 * These are the decisions that make the difference between a template and a real
 * notice, so they are pinned directly: the injected-config rules of
 * `lib/legal/config.ts`, the section inventory the document component renders,
 * and the catalogs it renders them from. The rendered HTML contract (draft
 * banner, `data-legal-status`, noindex meta, hreflang) needs the Next server
 * runtime and is already covered end to end by
 * `scripts/smoke/smoke-legal-pages.mts`; `components/legal/legal-document.tsx` cannot
 * be executed under Vitest because it calls `next-intl/server`.
 */
const legalZh = (legalZhFile as Record<string, unknown>).Legal as Record<string, unknown>;
const legalEn = (legalEnFile as Record<string, unknown>).Legal as Record<string, unknown>;
const mergedLegal = Object.fromEntries([
  ['zh-CN', zhBundle as Record<string, unknown>],
  ['en', enBundle as Record<string, unknown>],
  ['ja', jaBundle as Record<string, unknown>],
  ['de', deBundle as Record<string, unknown>],
  ['es', esBundle as Record<string, unknown>],
  ['fr', frBundle as Record<string, unknown>],
].map(([locale, bundle]) => [locale, (bundle as Record<string, unknown>).Legal as Record<string, unknown>])) as
  Record<Locale, Record<string, unknown>>;
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
/**
 * `LocalizedLegalText` requires every routable locale, so published-fact fixtures
 * fill all of them with one text and override only the locale under test.
 */
function localized(text: string, overrides: Partial<Record<Locale, string>> = {}): Record<Locale, string> {
  return Object.fromEntries(
    routing.locales.map((locale) => [locale, overrides[locale] ?? text]),
  ) as Record<Locale, string>;
}
const SECTION_ORDER: Record<LegalDocumentKind, readonly string[]> = {
  privacy: ['account', 'billing', 'email', 'browser', 'controls', 'retention'],
  terms: ['account', 'payments', 'subscription', 'referrals', 'email', 'availability'],
};
const CONFIG_FIELDS: LegalMissingField[] = ['operatorName', 'supportContact',
  'effectiveDate', 'privacyDetails', 'termsDetails', 'approvedForPublication'];

function translation(namespace: Record<string, unknown>, path: string): string {
  const value = path.split('.').reduce<unknown>(
    (current, key) => (current && typeof current === 'object'
      ? (current as Record<string, unknown>)[key] : undefined), namespace);
  if (typeof value !== 'string') throw new Error(`Missing message: ${path}`);
  return value;
}

/** A configuration an operator could realistically publish. */
function publishableConfig(overrides: Partial<LegalConfig> = {}): LegalConfig {
  return {
    operatorName: 'Example Operator Ltd.',
    supportContact: {
      label: localized('Support email', { 'zh-CN': '支持邮箱' }),
      href: 'mailto:support@example.test',
    },
    effectiveDate: '2026-01-15',
    privacyDetails: localized('We process data only as required to run the service.',
      { 'zh-CN': '我们只在提供服务所需范围内处理数据。' }),
    termsDetails: localized('The commercial terms on this page govern the service.',
      { 'zh-CN': '商业条款以本页说明为准。' }),
    approvedForPublication: true,
    ...overrides,
  };
}

describe('published legal template', () => {
  it('ships every field unset so a template can never be mistaken for a notice', () => {
    expect(legalConfig).toEqual({
      operatorName: null,
      supportContact: null,
      effectiveDate: null,
      privacyDetails: null,
      termsDetails: null,
      approvedForPublication: false,
    });
  });

  it('is a draft and lists the missing fields in the order the notice renders them', () => {
    const status = getLegalPublicationStatus(legalConfig);
    expect(status.isDraft).toBe(true);
    expect(status.missingFields).toEqual(CONFIG_FIELDS);
  });
});

describe('publication status', () => {
  it('approves a configuration that supplies every public fact', () => {
    const status = getLegalPublicationStatus(publishableConfig());
    expect(status).toEqual({ isDraft: false, missingFields: [] });
  });

  it('names exactly the field that is missing, for every field', () => {
    for (const field of CONFIG_FIELDS) {
      const broken = publishableConfig(field === 'supportContact'
        ? { supportContact: null }
        : field === 'effectiveDate'
          ? { effectiveDate: null }
          : field === 'operatorName'
            ? { operatorName: '   ' }
            : field === 'approvedForPublication'
              ? { approvedForPublication: false }
              : { [field]: null } as Partial<LegalConfig>);
      const status = getLegalPublicationStatus(broken);
      expect(status.isDraft, field).toBe(true);
      expect(status.missingFields, field).toEqual([field]);
    }
  });

  it('never approves a date that is not a real calendar day', () => {
    for (const effectiveDate of ['2026-02-30', '2026-13-01', '2026-1-5', '15/01/2026',
      '2026-01-15T00:00:00Z', 'tomorrow']) {
      const status = getLegalPublicationStatus(publishableConfig({ effectiveDate }));
      expect(status.missingFields, effectiveDate).toContain('effectiveDate');
    }
    // A leap day is a real date and must be accepted.
    expect(getLegalPublicationStatus(publishableConfig({ effectiveDate: '2028-02-29' }))
      .missingFields).toEqual([]);
  });

  it('accepts a support contact only when every translation and a usable scheme are present', () => {
    const cases: Array<[string, LegalConfig['supportContact'], boolean]> = [
      ['no contact', null, false],
      ['mailto', { label: localized('Email', { 'zh-CN': '邮箱' }), href: 'mailto:support@example.test' }, true],
      ['https', { label: localized('Help', { 'zh-CN': '帮助' }), href: 'https://support.example.test/help' }, true],
      ['http is not a secure contact', { label: localized('Help', { 'zh-CN': '帮助' }), href: 'http://support.example.test' }, false],
      ['mailto with a query', { label: localized('Email', { 'zh-CN': '邮箱' }), href: 'mailto:support@example.test?subject=hi' }, false],
      ['mailto without a domain', { label: localized('Email', { 'zh-CN': '邮箱' }), href: 'mailto:support' }, false],
      ['a bare string is not a url', { label: localized('Email', { 'zh-CN': '邮箱' }), href: 'support@example.test' }, false],
      ['javascript scheme', { label: localized('Email', { 'zh-CN': '邮箱' }), href: 'javascript:alert(1)' }, false],
      ['a blank English label', { label: localized('Email', { en: '   ' }), href: 'mailto:support@example.test' }, false],
      ['a blank Japanese label', { label: localized('Email', { ja: '' }), href: 'mailto:support@example.test' }, false],
    ];
    for (const [name, supportContact, usable] of cases) {
      const status = getLegalPublicationStatus(publishableConfig({ supportContact }));
      expect(status.missingFields.includes('supportContact'), name).toBe(!usable);
      expect(Boolean(getLegalSupportContact(publishableConfig({ supportContact }))), name).toBe(usable);
    }
  });

  it('normalises the published contact link instead of echoing the raw input', () => {
    const configured = publishableConfig({
      supportContact: { label: localized('Email', { 'zh-CN': '邮箱' }), href: '  mailto:SUPPORT@Example.Test  ' },
    });
    expect(getLegalSupportContact(configured)?.href).toBe('mailto:SUPPORT@Example.Test');
  });

  it('requires every site locale of a details paragraph before it counts as configured', () => {
    // One blank locale renders an empty page for that visitor, so a partial
    // translation must block publication instead of silently falling back.
    const status = getLegalPublicationStatus(publishableConfig({
      privacyDetails: localized('Only one language is filled in.', { en: '' }),
    }));
    expect(status.missingFields).toEqual(['privacyDetails']);

    for (const locale of routing.locales) {
      const blocked = getLegalPublicationStatus(publishableConfig({
        privacyDetails: localized('Filled in everywhere.', { [locale]: '   ' }),
      }));
      expect(blocked.missingFields, `blank ${locale}`).toEqual(['privacyDetails']);
    }

    const termsOnly = getLegalPublicationStatus(publishableConfig({
      termsDetails: null,
    }));
    expect(termsOnly.missingFields).toEqual(['termsDetails']);
  });

  it('refuses to approve an operator name made of whitespace', () => {
    for (const operatorName of ['', '   ', '\n']) {
      expect(getLegalPublicationStatus(publishableConfig({ operatorName })).missingFields)
        .toEqual(['operatorName']);
    }
  });
});

describe('legal document inventory', () => {
  it('keeps the two document kinds distinct and page-complete', async () => {
    // Importing the component would pull `next-intl/server` into Vitest, which
    // cannot resolve `next/headers`; its published inventory is therefore read
    // from the source. Rendering stays covered by scripts/smoke/smoke-legal-pages.mts.
    const component = new URL('../components/legal/legal-document.tsx', import.meta.url);
    const { readFile } = createRequire(import.meta.url)('node:fs/promises') as {
      readFile: (path: URL, encoding: 'utf8') => Promise<string>;
    };
    const source = await readFile(component, 'utf8');
    for (const [kind, sections] of Object.entries(SECTION_ORDER)) {
      expect(source, `${kind} inventory`).toContain(`${kind}: [${sections
        .map((section) => `'${section}'`).join(', ')}]`);
    }
    expect(Object.keys(SECTION_ORDER)).toEqual(['privacy', 'terms']);
  });

  it('documents every section it renders, in every locale, with real prose', () => {
    for (const [kind, sections] of Object.entries(SECTION_ORDER)) {
      for (const [locale, namespace] of Object.entries(mergedLegal)) {
        for (const section of sections) {
          const path = `${kind}.sections.${section}`;
          expect(translation(namespace, `${path}.title`).trim().length,
            `${locale} ${kind}.${section} title`).toBeGreaterThan(0);
          expect(translation(namespace, `${path}.body`).trim().length,
            `${locale} ${kind}.${section} body`).toBeGreaterThan(40);
        }
      }
      expect(sections.length).toBe(new Set(sections).size);
    }
  });

  it('writes the Chinese bodies in Chinese and the Latin-script bodies without CJK', () => {
    // Japanese is excluded on purpose: its legal prose legitimately uses kanji.
    for (const [kind, sections] of Object.entries(SECTION_ORDER)) {
      for (const section of sections) {
        expect(CJK.test(translation(legalZh, `${kind}.sections.${section}.body`)),
          `zh-CN ${kind}.${section}`).toBe(true);
        for (const locale of ['en', 'de', 'es', 'fr'] as const) {
          expect(CJK.test(translation(mergedLegal[locale], `${kind}.sections.${section}.body`)),
            `${locale} ${kind}.${section}`).toBe(false);
        }
      }
    }
  });

  it('labels every configurable field and every draft/unconfigured state in every locale', () => {
    for (const [locale, namespace] of Object.entries(mergedLegal)) {
      for (const field of CONFIG_FIELDS) {
        expect(translation(namespace, `fields.${field}`).trim().length, `${locale} ${field}`)
          .toBeGreaterThan(0);
      }
      for (const key of ['draft.heading', 'draft.body', 'draft.missing', 'draftTitle',
        'unconfigured', 'contents', 'turnstileSource', 'navigation.skip', 'navigation.home',
        'navigation.primary', 'navigation.documents', 'privacy.title', 'privacy.description',
        'privacy.detailsTitle', 'privacy.detailsMissing', 'terms.title', 'terms.description',
        'terms.detailsTitle', 'terms.detailsMissing']) {
        expect(translation(namespace, key).trim().length, `${locale} ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('tells the reader which fields are still missing, in both locales', () => {
    const draftTitle = translation(legalZh, 'draftTitle');
    expect(draftTitle).toContain('{title}');
    expect(draftTitle.replace('{title}', translation(legalZh, 'privacy.title')))
      .toContain(translation(legalZh, 'privacy.title'));
    expect(translation(legalZh, 'draft.missing').trim().length).toBeGreaterThan(0);
    expect(translation(legalEn, 'draft.missing').trim().length).toBeGreaterThan(0);
    expect(translation(legalZh, 'unconfigured')).not.toBe(translation(legalEn, 'unconfigured'));
  });
});
