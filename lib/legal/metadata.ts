import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import type { Locale } from '@/i18n/routing';
import { publicPageMetadata } from '@/lib/seo';
import { getLegalPublicationStatus, type LegalDocumentKind } from './config';

export async function legalPageMetadata(locale: Locale, kind: LegalDocumentKind): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'Legal' });
  const { isDraft } = getLegalPublicationStatus();
  const title = isDraft ? t('draftTitle', { title: t(`${kind}.title`) }) : t(`${kind}.title`);
  return {
    ...publicPageMetadata(locale, kind === 'privacy' ? '/privacy' : '/terms', title, t(`${kind}.description`)),
    robots: { index: !isDraft, follow: !isDraft },
  };
}
