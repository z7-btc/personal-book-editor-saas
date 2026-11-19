import { routing, type Locale } from '@/i18n/routing';

export type LegalDocumentKind = 'privacy' | 'terms';
export type LocalizedLegalText = Readonly<Record<Locale, string>>;

/** Public deployment facts only. Never put credentials or private keys here. */
export type LegalConfig = {
  operatorName: string | null;
  supportContact: { label: LocalizedLegalText; href: string } | null;
  effectiveDate: string | null;
  /** Actual recipients, hosting regions, retention and rights request process. */
  privacyDetails: LocalizedLegalText | null;
  /** Actual commercial policies, eligibility and deployment limitations. */
  termsDetails: LocalizedLegalText | null;
  approvedForPublication: boolean;
};

/**
 * Deliberately incomplete template. The operator must supply verified public
 * facts, review both translations and explicitly approve publication.
 * This switch does not prove legal compliance or production readiness.
 */
export const legalConfig: Readonly<LegalConfig> = {
  operatorName: null,
  supportContact: null,
  effectiveDate: null,
  privacyDetails: null,
  termsDetails: null,
  approvedForPublication: false,
};

export type LegalMissingField = keyof LegalConfig;

/**
 * A legal document is publishable only when every locale the site serves has
 * text. Partial coverage would render one language's page from an empty
 * string, so a missing translation blocks publication instead of falling back
 * silently.
 */
function hasLocalizedText(value: LocalizedLegalText | null): boolean {
  if (!value) return false;
  return routing.locales.every((locale) => Boolean(value[locale]?.trim()));
}

export function getLegalSupportContact(config: Readonly<LegalConfig> = legalConfig) {
  const contact = config.supportContact;
  if (!contact || !hasLocalizedText(contact.label)) return null;
  try {
    const url = new URL(contact.href.trim());
    const isEmail = url.protocol === 'mailto:' &&
      /^[^\s@?]+@[^\s@?]+\.[^\s@?]+$/.test(url.pathname) && !url.search && !url.hash;
    const isWeb = url.protocol === 'https:' && !url.username && !url.password;
    return isEmail || isWeb ? { ...contact, href: url.href } : null;
  } catch {
    return null;
  }
}

function hasEffectiveDate(value: string | null): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function getLegalPublicationStatus(config: Readonly<LegalConfig> = legalConfig) {
  const missingFields: LegalMissingField[] = [];
  if (!config.operatorName?.trim()) missingFields.push('operatorName');
  if (!getLegalSupportContact(config)) missingFields.push('supportContact');
  if (!hasEffectiveDate(config.effectiveDate)) missingFields.push('effectiveDate');
  if (!hasLocalizedText(config.privacyDetails)) missingFields.push('privacyDetails');
  if (!hasLocalizedText(config.termsDetails)) missingFields.push('termsDetails');
  if (!config.approvedForPublication) missingFields.push('approvedForPublication');
  return { isDraft: missingFields.length > 0, missingFields };
}
