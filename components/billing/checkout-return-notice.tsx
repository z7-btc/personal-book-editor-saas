'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

/**
 * 付款回到站内后的开通提示。
 *
 * 支付中心的 `success_url` 是 `/dashboard?checkout=returned`，但浏览器先到、
 * webhook 后到是常态：回跳本身不等于权益已经落地。所以这里不凭参数庆祝，
 * 而是轮询 `/api/subscription/access`，等判定真的变成「有效付费周期」再弹窗。
 * 页面开着的时候 webhook 慢几秒也能等到；超过一分钟还没落地就换成「付款已
 * 收到、正在确认」，不谎报开通。
 *
 * 处理完（或放弃）会把 `checkout` 参数从地址栏抹掉，刷新不会重复弹。
 */
export type ToolAccessSnapshot = {
  enforced: boolean;
  allowed: boolean;
  reason: 'active' | 'exempt' | 'inactive' | 'not_enforced';
};

const POLL_INTERVAL_MILLIS = 2_500;
const CONFIRMING_DELAY_MILLIS = 4_000;
const POLL_TIMEOUT_MILLIS = 60_000;

type Phase = 'idle' | 'polling' | 'success' | 'pending';

export function CheckoutReturnNotice({ initialAccess }: { initialAccess: ToolAccessSnapshot }) {
  const t = useTranslations('CheckoutReturn');
  const searchParams = useSearchParams();
  // 首帧就定下姿态：回跳参数在、服务端已判定付费有效，就直接成功；否则进入轮询。
  const [phase, setPhase] = useState<Phase>(() => {
    if (searchParams.get('checkout') !== 'returned') return 'idle';
    return initialAccess.allowed && initialAccess.reason === 'active' ? 'success' : 'polling';
  });
  const [confirming, setConfirming] = useState(false);

  const clearCheckoutParam = useCallback(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('checkout')) return;
    url.searchParams.delete('checkout');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const settle = useCallback((next: 'success' | 'pending') => {
    setConfirming(false);
    setPhase(next);
    clearCheckoutParam();
  }, [clearCheckoutParam]);

  // 处理完就把参数抹掉：即使首帧直接成功，也不会留在地址栏里等着刷新重弹。
  useEffect(() => {
    if (phase === 'success' || phase === 'pending') clearCheckoutParam();
  }, [phase, clearCheckoutParam]);

  useEffect(() => {
    if (phase !== 'polling') return;
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();
    const confirmingTimer = window.setTimeout(() => {
      if (!cancelled) setConfirming(true);
    }, CONFIRMING_DELAY_MILLIS);

    const check = async () => {
      try {
        const response = await fetch('/api/subscription/access', { cache: 'no-store' });
        if (!response.ok) return false;
        const payload = await response.json().catch(() => null);
        return payload?.data?.allowed === true && payload?.data?.reason === 'active';
      } catch {
        return false;
      }
    };

    const schedule = () => {
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        if (await check()) {
          if (!cancelled) settle('success');
          return;
        }
        if (Date.now() - startedAt >= POLL_TIMEOUT_MILLIS) {
          if (!cancelled) settle('pending');
          return;
        }
        schedule();
      }, POLL_INTERVAL_MILLIS);
    };

    void (async () => {
      if (await check()) {
        if (!cancelled) settle('success');
        return;
      }
      if (!cancelled) schedule();
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(confirmingTimer);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [phase, settle]);

  useEffect(() => {
    if (phase !== 'success' && phase !== 'pending') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPhase('idle');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [phase]);

  if (phase === 'idle') return null;

  if (phase === 'polling') {
    if (!confirming) return null;
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4" role="status" aria-live="polite">
        <div className="animate-in fade-in slide-in-from-bottom-2 flex items-center gap-2.5 rounded-full border border-gray-200 bg-white/95 px-4 py-2.5 text-sm font-medium text-gray-700 shadow-lg backdrop-blur dark:border-gray-700 dark:bg-gray-900/95 dark:text-gray-200">
          <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
          {t('confirming')}
        </div>
      </div>
    );
  }

  const success = phase === 'success';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkout-return-title"
      data-checkout-return={phase}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPhase('idle');
      }}
    >
      <div className="relative my-auto w-full max-w-md overflow-hidden rounded-3xl border border-emerald-200/70 bg-white px-6 py-8 text-center shadow-2xl animate-in fade-in zoom-in-95 duration-300 dark:border-emerald-900/60 dark:bg-gray-900 sm:px-8">
        <button
          type="button"
          onClick={() => setPhase('idle')}
          aria-label={t('close')}
          className="absolute right-4 top-4 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 dark:hover:bg-gray-800 dark:hover:text-gray-200 dark:focus-visible:ring-offset-gray-900"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <div
          aria-hidden="true"
          className={`pointer-events-none absolute -top-24 left-1/2 h-56 w-56 -translate-x-1/2 rounded-full blur-3xl ${
            success ? 'bg-emerald-400/25' : 'bg-amber-400/20'
          }`}
        />

        <div className="relative mx-auto flex h-20 w-20 items-center justify-center">
          {success && <span aria-hidden="true" className="checkout-halo absolute inset-0 rounded-full bg-emerald-400/35" />}
          <span
            className={`relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br shadow-lg ${
              success
                ? 'from-emerald-400 to-teal-500 shadow-emerald-500/30'
                : 'from-amber-400 to-orange-500 shadow-amber-500/30'
            }`}
          >
            {success ? (
              <svg aria-hidden="true" viewBox="0 0 32 32" className="h-10 w-10" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path className="checkout-check" d="M9 16.5l4.5 4.5L23 11.5" />
              </svg>
            ) : (
              <svg aria-hidden="true" viewBox="0 0 32 32" className="h-10 w-10" fill="none" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="16" cy="16" r="10.5" />
                <path d="M16 10.5V16l3.8 2.4" />
              </svg>
            )}
          </span>
        </div>

        <h2 id="checkout-return-title" className="relative mt-6 text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
          {success ? t('successTitle') : t('pendingTitle')}
        </h2>
        <p className="relative mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">
          {success ? t('successBody') : t('pendingBody')}
        </p>

        {success && (
          <ul className="relative mt-6 grid gap-2 rounded-2xl border border-emerald-100 bg-emerald-50/70 p-3 text-left dark:border-emerald-900/50 dark:bg-emerald-950/30">
            {[t('unlockedLibrary'), t('unlockedRewrite'), t('unlockedExport')].map((item) => (
              <li key={item} className="flex items-center gap-2.5 text-sm font-medium text-emerald-900 dark:text-emerald-100">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 dark:bg-emerald-400/20">
                  <svg aria-hidden="true" viewBox="0 0 20 20" className="h-3 w-3 text-emerald-600 dark:text-emerald-300" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4.5 10.5l3.4 3.4L15.5 6" />
                  </svg>
                </span>
                {item}
              </li>
            ))}
          </ul>
        )}

        <div className="relative mt-7 space-y-3">
          {success ? (
            <>
              <Link
                href="/dashboard/library"
                autoFocus
                onClick={() => setPhase('idle')}
                className="inline-flex w-full items-center justify-center rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-500/25 transition hover:from-emerald-400 hover:to-teal-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
              >
                {t('successCta')}
              </Link>
              <Link
                href="/dashboard/billing"
                onClick={() => setPhase('idle')}
                className="block text-sm font-medium text-gray-500 underline-offset-4 transition-colors hover:text-gray-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 dark:text-gray-400 dark:hover:text-gray-200"
              >
                {t('viewBilling')}
              </Link>
            </>
          ) : (
            <>
              <button
                type="button"
                autoFocus
                onClick={() => window.location.reload()}
                className="inline-flex w-full items-center justify-center rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-amber-500/25 transition hover:from-amber-400 hover:to-orange-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
              >
                {t('pendingRefresh')}
              </button>
              <Link
                href="/dashboard/billing"
                onClick={() => setPhase('idle')}
                className="block text-sm font-medium text-gray-500 underline-offset-4 transition-colors hover:text-gray-800 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 dark:text-gray-400 dark:hover:text-gray-200"
              >
                {t('viewBilling')}
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
