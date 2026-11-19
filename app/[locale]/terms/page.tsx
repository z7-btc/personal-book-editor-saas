import type { Metadata } from 'next';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { LegalDocument } from '@/components/legal/legal-document';
import { routing } from '@/i18n/routing';
import { legalPageMetadata } from '@/lib/legal/metadata';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  return legalPageMetadata(locale, 'terms');
}

export default async function TermsPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  return <LegalDocument locale={locale} kind="terms" />;
}
