import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { notFound } from 'next/navigation';
import * as rootParams from 'next/root-params';
import { routing, type Locale } from './routing';

/**
 * One loader per locale. Each import is a static specifier on purpose: the
 * bundler can then carry a missing file to build time, and adding a locale to
 * `routing.locales` without adding a loader here is a type error rather than a
 * runtime 500.
 */
const loaders: Record<Locale, () => Promise<{ default: Record<string, unknown> }>> = {
  en: () => import('../messages/en.json'),
  'zh-CN': () => import('../messages/zh-CN.json'),
  ja: () => import('../messages/ja.json'),
  de: () => import('../messages/de.json'),
  es: () => import('../messages/es.json'),
  fr: () => import('../messages/fr.json'),
};

export default getRequestConfig(async ({ locale }) => {
  const requested = locale || await rootParams.locale();
  if (!hasLocale(routing.locales, requested)) notFound();
  return {
    locale: requested,
    messages: (await loaders[requested]()).default,
  };
});
