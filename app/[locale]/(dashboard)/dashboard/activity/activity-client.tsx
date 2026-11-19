'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CreditCard, History, LoaderCircle, ShieldCheck, UserRound } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { activityEventTypes, type ActivityFeed, type ActivityItem } from '@/lib/activity/events';

function validFeed(value: unknown): value is ActivityFeed {
  if (!value || typeof value !== 'object') return false;
  const feed = value as Partial<ActivityFeed>;
  return Array.isArray(feed.items) && feed.items.length <= 50 &&
    (feed.nextCursor === null || (typeof feed.nextCursor === 'string' && feed.nextCursor.length <= 256)) &&
    feed.items.every((item: ActivityItem) => item && typeof item.id === 'string' && /^[1-9][0-9]{0,18}$/.test(item.id) &&
      activityEventTypes.includes(item.type) && ['account', 'security', 'billing'].includes(item.category) &&
      typeof item.occurredAt === 'string' && Number.isFinite(Date.parse(item.occurredAt)));
}

export default function ActivityClient({ initial, unavailable }: { initial: ActivityFeed | null; unavailable: boolean }) {
  const t = useTranslations('Activity');
  const locale = useLocale();
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const [items, setItems] = useState(initial?.items ?? []);
  const [cursor, setCursor] = useState(initial?.nextCursor ?? null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(unavailable);
  const [expired, setExpired] = useState(false);

  async function loadOlder() {
    if (!cursor || loading || expired) return;
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/account/activity?${new URLSearchParams({ cursor })}`, {
        cache: 'no-store', credentials: 'same-origin',
      });
      if (response.status === 401) { setExpired(true); return; }
      if (!response.ok) throw new Error('ACTIVITY_UNAVAILABLE');
      const envelope = await response.json() as { data?: unknown };
      if (!validFeed(envelope.data)) throw new Error('INVALID_FEED');
      const data = envelope.data;
      setItems((previous) => {
        const existing = new Set(previous.map((item) => item.id));
        return [...previous, ...data.items.filter((item) => !existing.has(item.id))];
      });
      setCursor(data.nextCursor);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }

  return (
    <section className="overflow-hidden rounded-xl border bg-white dark:border-gray-700 dark:bg-gray-900" aria-busy={loading}>
      <header className="border-b border-gray-100 p-6 sm:p-8 dark:border-gray-800">
        <div className="mb-4 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <History className="size-4" aria-hidden="true" /><span>{t('eyebrow')}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600 dark:text-gray-300">{t('description')}</p>
        <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">{t('timezone')}</p>
      </header>
      {failed && <p role="alert" className="mx-6 mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">{t('unavailable')}</p>}
      {expired && <p role="alert" className="mx-6 mt-5 text-sm">{t('sessionExpired')} <Link href="/sign-in" className="underline underline-offset-4">{t('signIn')}</Link></p>}
      {!items.length && !failed ? (
        <div className="px-6 py-14 text-center sm:px-8">
          <History className="mx-auto mb-4 size-7 text-gray-400" aria-hidden="true" />
          <h2 className="text-base font-medium">{t('emptyTitle')}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-500 dark:text-gray-400">{t('emptyDescription')}</p>
        </div>
      ) : (
        <ol aria-label={t('feedLabel')} className="divide-y divide-gray-100 px-6 sm:px-8 dark:divide-gray-800">
          {items.map((item) => {
            const Icon = item.category === 'billing' ? CreditCard : item.category === 'security' ? ShieldCheck : UserRound;
            return (
              <li key={item.id} className="grid gap-3 py-5 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-5">
                <time dateTime={item.occurredAt} className="pt-1 text-xs leading-5 tabular-nums text-gray-500 dark:text-gray-400">{formatter.format(new Date(item.occurredAt))}</time>
                <div className="flex min-w-0 items-start gap-3">
                  <div className="rounded-lg border border-gray-100 bg-gray-50 p-2 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"><Icon className="size-4" aria-hidden="true" /></div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h2 className="text-sm font-medium">{t(`events.${item.type}.title`)}</h2>
                      <span className="text-xs text-gray-500 dark:text-gray-400">{t(`categories.${item.category}`)}</span>
                    </div>
                    <p className="mt-1 text-sm leading-6 text-gray-500 dark:text-gray-400">{t(`events.${item.type}.description`)}</p>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {items.length > 0 && <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-6 py-5 sm:px-8 dark:border-gray-800">
        <p role="status" aria-live="polite" className="text-xs text-gray-500 dark:text-gray-400">{t('loaded', { count: items.length })}</p>
        {cursor && !expired ? <button type="button" onClick={loadOlder} disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800">
          {loading && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {loading ? t('loading') : t('loadOlder')}
        </button> : !expired && <span className="text-xs text-gray-500 dark:text-gray-400">{t('end')}</span>}
      </footer>}
    </section>
  );
}
