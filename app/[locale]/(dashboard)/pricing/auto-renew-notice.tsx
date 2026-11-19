'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod';
import { Link } from '@/i18n/navigation';

const subscriptionSchema = z.object({
  productCode: z.string(), periodEnd: z.iso.datetime(), status: z.string(),
  autoRenewEnabled: z.boolean(), providerPeriodEnd: z.number().nullable(),
});
type Subscription = z.infer<typeof subscriptionSchema>;

/**
 * What the buyer should know about the subscription they already have, shown in
 * the payment window before they commit.
 *
 * Paying again leaves an existing Stripe mandate running, and what that means
 * depends on what is being bought:
 *
 * - the same plan: the new time stacks on top of the running period and the
 *   mandate keeps renewing. The buyer keeps that choice — the switch to turn it
 *   off stays on the billing page rather than appearing here, where it would be
 *   one more thing to decide before paying;
 * - a different plan: the mandate would go on paying for a plan nobody uses, so
 *   it is cancelled once the new payment settles. Saying so up front is the whole
 *   point — someone who pays by crypto to stop being charged should not discover
 *   a further charge afterwards.
 *
 * Nothing is shown when there is no live Stripe subscription (404) or its
 * renewal is already off: there is nothing to warn about.
 */
export function AutoRenewNotice({ productCode }: { productCode: string }) {
  const t = useTranslations('Pricing');
  const locale = useLocale();
  const [subscription, setSubscription] = useState<Subscription | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/payment-center/subscription', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const parsed = subscriptionSchema.safeParse((await response.json()).data);
        if (parsed.success) setSubscription(parsed.data);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (!subscription?.autoRenewEnabled) return null;
  // The centre's own period end is the date the next charge lands on; the stored
  // one is when access runs out. They differ once a prepaid top-up has pushed
  // the paid period past the renewal.
  const nextCharge = subscription.providerPeriodEnd
    ? new Date(subscription.providerPeriodEnd * 1000) : new Date(subscription.periodEnd);
  const samePlan = subscription.productCode === productCode;

  return (
    <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      {samePlan
        ? t('autoRenewNotice', { date: nextCharge.toLocaleDateString(locale) })
        : t('autoRenewPlanSwitch')}{' '}
      {samePlan && (
        <Link href="/dashboard/billing" className="underline">
          {t('autoRenewBillingLink')}
        </Link>
      )}
    </p>
  );
}
