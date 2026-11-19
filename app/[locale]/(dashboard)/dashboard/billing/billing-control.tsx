'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';

const subscriptionSchema = z.object({
  productCode: z.string(), periodEnd: z.iso.datetime(), status: z.string(),
  autoRenewEnabled: z.boolean(), providerPeriodEnd: z.number().nullable(),
});
type Subscription = z.infer<typeof subscriptionSchema>;

type View =
  | { state: 'loading' | 'none' | 'unavailable' | 'error' }
  | { state: 'ready'; data: Subscription };

export function BillingControl() {
  const t = useTranslations('Billing');
  const history = useTranslations('BillingHistory');
  const locale = useLocale();
  const [view, setView] = useState<View>({ state: 'loading' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/payment-center/subscription', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) return setView({ state: 'none' });
        if (response.status === 503) return setView({ state: 'unavailable' });
        if (!response.ok) return setView({ state: 'error' });
        const result = await response.json();
        setView({ state: 'ready', data: subscriptionSchema.parse(result.data) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setView({ state: 'error' });
      });
    return () => controller.abort();
  }, []);

  async function changeRenewal(enabled: boolean) {
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch('/api/payment-center/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Payment Center update failed');
      const result = await response.json();
      setView({ state: 'ready', data: subscriptionSchema.parse(result.data) });
      setMessage(t('saved'));
    } catch {
      setMessage(t('failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="max-w-2xl rounded-xl border bg-white p-8 dark:border-gray-700 dark:bg-gray-900">
      <h2 className="text-xl font-semibold">{history('renewalTitle')}</h2>
      {view.state === 'loading' && <p className="mt-4" role="status">{t('loading')}</p>}
      {view.state === 'none' && <p className="mt-4">{history('renewalUnavailable')}</p>}
      {view.state === 'unavailable' && <p className="mt-4">{t('unavailable')}</p>}
      {view.state === 'error' && <p className="mt-4" role="alert">{t('failed')}</p>}
      {view.state === 'ready' && (
        <div className="mt-6 space-y-4">
          <p>{t('plan', { product: view.data.productCode })}</p>
          <p>{t('paidUntil', { date: new Date(view.data.periodEnd).toLocaleDateString(locale) })}</p>
          <p>{t('renewal', { state: view.data.autoRenewEnabled ? t('on') : t('off') })}</p>
          <button type="button" disabled={saving}
            onClick={() => changeRenewal(!view.data.autoRenewEnabled)}
            className="min-h-11 rounded-lg bg-gray-900 px-5 py-3 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gray-600 disabled:opacity-50 dark:bg-white dark:text-gray-950 dark:focus-visible:outline-gray-300">
            {saving ? t('saving') : view.data.autoRenewEnabled ? t('disable') : t('enable')}
          </button>
          <p className="text-sm text-gray-600 dark:text-gray-300">{t('providerNote')}</p>
        </div>
      )}
      {message && <p className="mt-4" role="status">{message}</p>}
    </section>
  );
}
