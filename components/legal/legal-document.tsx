import { getTranslations } from 'next-intl/server';
import type { Locale } from '@/i18n/routing';
import {
  getLegalPublicationStatus, getLegalSupportContact, legalConfig,
  type LegalDocumentKind,
} from '@/lib/legal/config';
import { LegalPublicShell } from './public-shell';

/**
 * Published so the copy and the rendered outline can be checked against the same
 * inventory by `tests/legal.test.ts`; the array order is the reading order of
 * both the table of contents and the sections.
 */
export const legalSections = {
  privacy: ['account', 'billing', 'email', 'browser', 'controls', 'retention'],
  terms: ['account', 'payments', 'subscription', 'referrals', 'email', 'availability'],
} as const;

export async function LegalDocument({ locale, kind }: { locale: Locale; kind: LegalDocumentKind }) {
  const t = await getTranslations({ locale, namespace: 'Legal' });
  const sections = legalSections;
  const status = getLegalPublicationStatus();
  const contact = getLegalSupportContact();
  const details = kind === 'privacy' ? legalConfig.privacyDetails : legalConfig.termsDetails;
  const bodyClass = 'mt-3 whitespace-pre-line leading-7 text-gray-600 dark:text-gray-300';
  const effectiveDate = !status.missingFields.includes('effectiveDate') && legalConfig.effectiveDate
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${legalConfig.effectiveDate}T00:00:00Z`))
    : null;

  return (
    <LegalPublicShell locale={locale}>
      <main id="legal-content" tabIndex={-1} data-legal-document={kind} data-legal-status={status.isDraft ? 'draft' : 'approved'} className="mx-auto max-w-3xl px-5 py-16 outline-none">
        <h1 className="text-4xl font-semibold tracking-tight">{t(`${kind}.title`)}</h1>
        <p className="mt-4 text-lg leading-8 text-gray-600 dark:text-gray-300">{t(`${kind}.description`)}</p>

        {status.isDraft && (
          <aside role="note" aria-labelledby="legal-draft-title" data-legal-draft="true" data-missing-fields={status.missingFields.join(',')} className="mt-8 rounded-xl border border-gray-300 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
            <h2 id="legal-draft-title" className="font-semibold">{t('draft.heading')}</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">{t('draft.body')}</p>
            <p className="mt-4 text-sm font-medium">{t('draft.missing')}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-300">
              {status.missingFields.map((field) => <li key={field}>{t(`fields.${field}`)}</li>)}
            </ul>
          </aside>
        )}

        <dl className="mt-8 grid gap-5 border-y border-gray-200 py-6 text-sm sm:grid-cols-3 dark:border-gray-800">
          <div>
            <dt className="text-gray-500 dark:text-gray-400">{t('fields.operatorName')}</dt>
            <dd data-legal-field="operatorName" data-configured={!status.missingFields.includes('operatorName')} className="mt-2 break-words font-medium">{legalConfig.operatorName?.trim() || t('unconfigured')}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">{t('fields.supportContact')}</dt>
            <dd data-legal-field="supportContact" data-configured={Boolean(contact)} className="mt-2 break-words font-medium">
              {contact ? <a href={contact.href} className="underline underline-offset-4">{contact.label[locale]}</a> : t('unconfigured')}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">{t('fields.effectiveDate')}</dt>
            <dd data-legal-field="effectiveDate" data-configured={Boolean(effectiveDate)} className="mt-2 font-medium">{effectiveDate || t('unconfigured')}</dd>
          </div>
        </dl>

        <nav aria-label={t('contents')} className="mt-8">
          <h2 className="text-sm font-semibold">{t('contents')}</h2>
          <ol className="mt-3 grid list-decimal gap-x-8 gap-y-2 pl-5 text-sm text-gray-600 sm:grid-cols-2 dark:text-gray-300">
            {sections[kind].map((section) => (
              <li key={section}><a href={`#${section}`} className="hover:underline">{t(`${kind}.sections.${section}.title`)}</a></li>
            ))}
            <li><a href="#operator-details" className="hover:underline">{t(`${kind}.detailsTitle`)}</a></li>
          </ol>
        </nav>

        <div className="mt-12 space-y-10">
          {sections[kind].map((section) => (
            <section key={section} id={section} className="scroll-mt-8">
              <h2 className="text-xl font-semibold">{t(`${kind}.sections.${section}.title`)}</h2>
              <p className={bodyClass}>{t(`${kind}.sections.${section}.body`)}</p>
              {kind === 'privacy' && section === 'browser' && (
                <p className="mt-3 text-sm"><a href="https://www.cloudflare.com/turnstile-privacy-policy/" className="text-gray-600 underline underline-offset-4 dark:text-gray-300">{t('turnstileSource')}</a></p>
              )}
            </section>
          ))}
          <section id="operator-details" className="scroll-mt-8" data-legal-field={kind === 'privacy' ? 'privacyDetails' : 'termsDetails'} data-configured={Boolean(details?.[locale].trim())}>
            <h2 className="text-xl font-semibold">{t(`${kind}.detailsTitle`)}</h2>
            <p className={bodyClass}>{details?.[locale].trim() || t(`${kind}.detailsMissing`)}</p>
          </section>
        </div>
      </main>
    </LegalPublicShell>
  );
}
