'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowDown, RefreshCw, ReceiptText } from 'lucide-react';
import { billingHistorySchema, type BillingHistory, type BillingHistorySection } from '@/lib/billing/history-contract';
import { BillingControl } from './billing-control';

const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gray-600 disabled:opacity-50 dark:hover:bg-gray-800 dark:focus-visible:outline-gray-300';

export function BillingHistoryView({ initial }: { initial: BillingHistory | null }) {
  const t = useTranslations('BillingHistory');
  const locale = useLocale();
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<BillingHistorySection | null>(null);
  const [failed, setFailed] = useState(initial === null);
  const activeRequest = useRef<AbortController | null>(null);
  const failureCount = useRef(0);
  const date = (value: string, time = false) => new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    ...(time ? { hour: '2-digit', minute: '2-digit' } as const : {}),
  }).format(new Date(value));
  // A buyout is a period ending in year 9999; printing that date would read as
  // a bug, so it is shown as what it means.
  const isPermanent = (value: string) => new Date(value).getUTCFullYear() >= 9000;
  const bound = (value: string) => (isPermanent(value) ? t('permanent') : date(value));
  // A channel added in the Payment Center has no local translation yet. Show a
  // readable fallback instead of leaking the missing i18n key to the buyer.
  const methodLabel = (method: string | null | undefined) => {
    if (!method) return '';
    const key = `methods.${method}`;
    return t.has(key) ? t(key) : method.replaceAll('_', ' ');
  };

  const read = useCallback(async (section: BillingHistorySection = 'all', cursor?: string) => {
    if (activeRequest.current || document.visibilityState === 'hidden') return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(section);
    try {
      const query = new URLSearchParams({ section });
      if (cursor) query.set('cursor', cursor);
      const response = await fetch(`/api/account/billing?${query}`, {
        cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
      });
      if (response.status === 401 || response.status === 403) setData(null);
      if (!response.ok) throw new Error('BILLING_READ_FAILED');
      const parsed = billingHistorySchema.parse((await response.json()).data);
      if (controller.signal.aborted) return;
      setData((previous) => {
        if (!cursor || !previous) return parsed;
        const merged = new Map([...previous[section as 'orders' | 'payments'].items,
          ...parsed[section as 'orders' | 'payments'].items].map((item) => [item.id, item]));
        return { ...previous, asOf: parsed.asOf, paymentEnabled: parsed.paymentEnabled,
          subscription: parsed.subscription,
          [section]: { items: [...merged.values()], nextCursor: parsed[section as 'orders' | 'payments'].nextCursor } };
      });
      setFailed(false);
      failureCount.current = 0;
    } catch {
      if (!controller.signal.aborted) { setFailed(true); failureCount.current++; }
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        if (!controller.signal.aborted) setBusy(null);
      }
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let mounted = true;
    const tick = async () => {
      await read();
      if (mounted) timer = setTimeout(tick, Math.min(300_000, 30_000 * 2 ** Math.min(4, failureCount.current)));
    };
    const focus = () => { void read(); };
    const visibility = () => { if (document.visibilityState === 'visible') void read(); };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    timer = setTimeout(tick, 30_000);
    return () => {
      mounted = false; clearTimeout(timer); activeRequest.current?.abort();
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [read]);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div><h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-gray-600 dark:text-gray-300">{t('subtitle')}</p></div>
        <button type="button" onClick={() => void read()} disabled={busy !== null} className={buttonClass}>
          <RefreshCw className="size-4" aria-hidden="true" />{busy === 'all' ? t('loading') : t('refresh')}
        </button>
      </header>
      {failed && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
        {data ? t('stale') : t('failed')}</p>}
      {!data ? <button type="button" onClick={() => void read()} disabled={busy !== null} className={buttonClass}>{t('retry')}</button> : <>
        {!data.paymentEnabled && <p className="rounded-lg border px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{t('unavailable')}</p>}
        <section aria-labelledby="billing-current-title" className="rounded-2xl border bg-white p-6 sm:p-8 dark:border-gray-800 dark:bg-gray-900">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 id="billing-current-title" className="text-sm font-medium text-gray-600 dark:text-gray-300">{t('current')}</h2>
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${data.subscription.state === 'active' ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100' : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200'}`}>
              {t(data.subscription.state === 'active' ? 'active' : 'none')}</span>
          </div>
          {data.subscription.state === 'active' ? <>
            <p className="mt-6 break-words text-3xl font-semibold tracking-tight">{data.subscription.productCode}</p>
            <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <p>{methodLabel(data.subscription.method)}</p>
              <p>{isPermanent(data.subscription.periodEnd!)
                ? t('permanentAccess') : t('paidUntil', { date: date(data.subscription.periodEnd!) })}</p>
            </div>
            {data.subscription.method !== 'stripe' && <p className="mt-5 text-sm text-gray-600 dark:text-gray-300">{t('prepaid')}</p>}
          </> : <p className="mt-5 text-sm text-gray-600 dark:text-gray-300">{t('noAccess')}</p>}
        </section>
        {data.subscription.state === 'active' && data.subscription.method === 'stripe' && data.paymentEnabled && <BillingControl />}
        <section aria-labelledby="billing-payments-title" className="overflow-hidden rounded-2xl border bg-white dark:border-gray-800 dark:bg-gray-900">
          <div className="border-b p-6 dark:border-gray-800 sm:px-8"><h2 id="billing-payments-title" className="text-xl font-semibold tracking-tight">{t('payments')}</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">{t('paymentsNote')}</p></div>
          {!data.payments.items.length ? <Empty text={t('emptyPayments')} /> : <ul className="divide-y dark:divide-gray-800">
            {data.payments.items.map((payment) => <li key={payment.id} className="grid gap-4 p-6 sm:px-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto]">
              <div className="min-w-0"><p className="break-words font-medium">{payment.productCode}</p><p className="mt-1 text-xs text-gray-600 dark:text-gray-300">{methodLabel(payment.method)}</p>
                <p className="mt-3 text-xs text-gray-600 dark:text-gray-300">{date(payment.settledAt)}</p></div>
              <div className="min-w-0 text-sm"><p>{t(`paymentStates.${payment.status}`)}</p>
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">{t(`accessStates.${payment.access}`)}</p>
                <p className="mt-3 text-xs leading-5 text-gray-600 dark:text-gray-300">{t('period', { start: date(payment.periodStart), end: bound(payment.periodEnd) })}</p></div>
              <p className="max-w-full break-all font-mono text-sm font-medium tabular-nums md:text-right"><span className="sr-only">{t('amount')}: </span><bdi>{payment.amountDecimal} {payment.currency}</bdi></p>
            </li>)}
          </ul>}
          {data.payments.nextCursor && <More busy={busy !== null} label={busy === 'payments' ? t('loading') : t('loadMore')} onClick={() => void read('payments', data.payments.nextCursor!)} />}
        </section>
        <section aria-labelledby="billing-orders-title" className="overflow-hidden rounded-2xl border bg-white dark:border-gray-800 dark:bg-gray-900">
          <div className="border-b p-6 dark:border-gray-800 sm:px-8"><h2 id="billing-orders-title" className="text-xl font-semibold tracking-tight">{t('orders')}</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">{t('ordersNote')}</p></div>
          {!data.orders.items.length ? <Empty text={t('emptyOrders')} /> : <ul className="divide-y dark:divide-gray-800">
            {data.orders.items.map((order) => <li key={order.id} className="grid gap-4 p-6 sm:px-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto]">
              <div className="min-w-0"><p className="break-words font-medium">{order.productCode} <span className="text-xs font-normal text-gray-600 dark:text-gray-300">{t(`intervals.${order.interval}`)}</span></p>
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">{methodLabel(order.method)}</p></div>
              <div className="text-sm"><p>{t(`orderStates.${order.status}`)}</p><p className="mt-2 text-xs text-gray-600 dark:text-gray-300">{t('recordedAt', { date: date(order.recordedAt) })}</p></div>
              <p className="max-w-full break-all font-mono text-sm font-medium tabular-nums md:text-right"><span className="sr-only">{t('amount')}: </span><bdi>{order.amountDecimal} {order.currency}</bdi></p>
            </li>)}
          </ul>}
          {data.orders.nextCursor && <More busy={busy !== null} label={busy === 'orders' ? t('loading') : t('loadMore')} onClick={() => void read('orders', data.orders.nextCursor!)} />}
        </section>
        <footer className="space-y-2 text-xs leading-5 text-gray-600 dark:text-gray-300"><p>{t('factsNote')} {t('timesUtc')}</p><p>{t('asOf', { date: date(data.asOf, true) })}</p></footer>
      </>}
      <p role="status" aria-live="polite" className="sr-only">{busy ? t('loading') : ''}</p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex items-center gap-4 px-6 py-10 text-sm text-gray-600 dark:text-gray-300 sm:px-8"><ReceiptText className="size-5 shrink-0" aria-hidden="true" /><p>{text}</p></div>;
}

function More({ busy, label, onClick }: { busy: boolean; label: string; onClick: () => void }) {
  return <div className="border-t p-4 text-center dark:border-gray-800"><button type="button" onClick={onClick} disabled={busy} className={buttonClass}><ArrowDown className="size-4" aria-hidden="true" />{label}</button></div>;
}
