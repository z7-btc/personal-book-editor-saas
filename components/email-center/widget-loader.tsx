import { getCapabilities } from '@/lib/config';
import type { Locale } from '@/i18n/routing';
import { WidgetRuntime } from './widget-runtime';

/**
 * The locale is handed in by the page rather than read here: this stays a plain
 * function of its props, so the contract test can call it directly without a
 * React render context.
 */
export function EmailCenterWidget({ locale }: { locale: Locale }) {
  if (!getCapabilities().emailWidget.configured) return null;

  let scriptUrl: URL;
  try {
    scriptUrl = new URL('/email-center-widget.js?v=3', process.env.EMAIL_CENTER_URL);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(scriptUrl.protocol) ||
      (process.env.NODE_ENV === 'production' && scriptUrl.protocol !== 'https:')) {
    return null;
  }

  return <WidgetRuntime src={scriptUrl.href} locale={locale}
    widgetKey={process.env.NEXT_PUBLIC_EMAIL_CENTER_WIDGET_KEY!} />;
}
