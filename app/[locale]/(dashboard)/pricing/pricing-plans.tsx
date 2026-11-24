'use client';

import { useMemo, useState } from 'react';
import { useMessages, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { AutoRenewNotice } from './auto-renew-notice';
import { PaymentCenterCheckout } from './payment-center-widget';
import { PaymentWindow } from './payment-window';

type Price = { interval: string; amount_decimal: string; currency: string };
type Product = { code: string; name: string; description?: string | null; prices: Price[] };

const displayAmount = (value: string) => {
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
};

/**
 * A plan card only offers the interval it has a price for; the buyer picks the
 * plan and interval first, then the payment window opens with that one
 * combination locked. The widget itself never shows a plan or interval picker.
 */
export function PricingPlans({ products }: { products: Product[] }) {
  const t = useTranslations('Pricing');
  const messages = useMessages() as {
    Pricing?: { productDescriptions?: Record<string, unknown> };
  };
  const intervalLabels: Record<string, string> = {
    one_time: t('one_time'),
    month: t('month'),
    year: t('year'),
  };
  const toggleLabels: Record<string, string> = {
    month: t('billingMonthly'),
    year: t('billingYearly'),
  };
  const amountLabel = (price: Price) =>
    `${displayAmount(price.amount_decimal)} ${price.currency}`;
  // The catalogue carries one description for the product (written on the
  // payment side, in the operator's language). A locale that has reviewed copy
  // for this plan code renders it instead; anything unknown still falls back to
  // the catalogue text so a new plan is never blank. Reading our own message
  // object with Object.hasOwn keeps prototype keys (`constructor`, `__proto__`)
  // from being mistaken for translated copy.
  const localizedDescriptions = messages.Pricing?.productDescriptions ?? {};
  const descriptionFor = (product: Product) => {
    if (Object.hasOwn(localizedDescriptions, product.code)) {
      const localized = localizedDescriptions[product.code];
      if (typeof localized === 'string' && localized.trim() !== '') return localized;
    }
    return product.description;
  };

  const intervals = useMemo(() => {
    const seen = products.flatMap((product) => product.prices.map((price) => price.interval));
    return [...new Set(seen)].filter((interval) => interval !== 'one_time');
  }, [products]);

  const [interval, setInterval] = useState(intervals[0] ?? 'month');
  const [checkout, setCheckout] = useState<{ product: Product; price: Price } | null>(null);

  return (
    <>
      {intervals.length > 1 && (
        <div className="mt-8 flex justify-center">
          <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1 dark:border-gray-700 dark:bg-gray-800">
            {intervals.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setInterval(value)}
                className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                  interval === value
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-white'
                    : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
                }`}
              >
                {toggleLabels[value] ?? intervalLabels[value] ?? value}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {products.map((product) => {
          const price = product.prices.find((item) => item.interval === interval)
            ?? product.prices[0];
          const description = descriptionFor(product);
          return (
            <article
              key={product.code}
              className="flex flex-col rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900"
            >
              <h2 className="text-xl font-semibold">{product.name}</h2>
              {description && (
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{description}</p>
              )}
              <p className="mt-4 text-lg font-semibold">
                {amountLabel(price)}
                <span className="ml-1 text-sm font-normal text-gray-500 dark:text-gray-400">
                  / {intervalLabels[price.interval] ?? price.interval}
                </span>
              </p>
              <div className="mt-5 flex flex-1 items-end">
                <Button
                  className="w-full"
                  onClick={() => setCheckout({ product, price })}
                >
                  {t('selectPlan', {
                    interval: toggleLabels[price.interval] ?? intervalLabels[price.interval] ?? price.interval,
                    amount: amountLabel(price),
                  })}
                </Button>
              </div>
            </article>
          );
        })}
      </div>

      {checkout && (
        <PaymentWindow
          title={t('checkoutTitle')}
          closeLabel={t('close')}
          onClose={() => setCheckout(null)}
        >
          {/* Above the widget: what happens to a subscription the buyer is
              already paying for is decided here, not by the payment method. */}
          <AutoRenewNotice productCode={checkout.product.code} />
          <PaymentCenterCheckout
            productCode={checkout.product.code}
            billingInterval={checkout.price.interval}
            catalogCurrency={checkout.price.currency}
          />
        </PaymentWindow>
      )}
    </>
  );
}
