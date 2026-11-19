'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Host adapter for the remote Payment Center widget.
 *
 * The application decides *what* is being sold — plan, billing interval and
 * currency — and renders that choice itself (see `page.tsx`). This component
 * only runs the *payment* half: it mounts the remote script with the plan
 * locked, so the widget shows the payment methods for one known price instead
 * of a plan/interval picker.
 *
 * The script served by the Payment Center (`<baseUrl>/static/js/payment-center.js`)
 * owns the interface inside the mount point, exactly like the other sites
 * connected to the same centre.
 */
type WidgetSelection = {
  product_code: string;
  billing_interval: string;
  catalog_currency: string;
  payment_method: string;
  blockchain?: string;
  currency?: string;
};

type WidgetApi = {
  mount(target: Element, options: Record<string, unknown>): unknown;
};

type PublicConfig = { baseUrl: string; siteCode: string; methods: string[] };

const SCRIPT_ATTRIBUTE = 'data-payment-center-widget';
const TOKEN_URL = '/api/payment-center/embed-token';
const READY_TIMEOUT_MILLIS = 15_000;
const POLL_INTERVAL_MILLIS = 100;

function widgetApi(): WidgetApi | undefined {
  return (window as unknown as { PaymentCenter?: WidgetApi }).PaymentCenter;
}

/**
 * The script is loaded once per document, however often the page remounts.
 *
 * No `data-site` attribute is set on purpose: that attribute makes the script
 * auto-mount a second, unmanaged widget into `#payment-center`, which would
 * create its orders straight in the centre and bypass our billing records.
 * Everything the explicit `mount` call needs is passed in options instead.
 */
function loadWidgetScript(config: PublicConfig) {
  if (document.querySelector(`script[${SCRIPT_ATTRIBUTE}]`)) return;
  const script = document.createElement('script');
  script.src = `${config.baseUrl}/static/js/payment-center.js`;
  script.async = true;
  script.setAttribute(SCRIPT_ATTRIBUTE, '');
  document.head.append(script);
}

async function readPublicConfig(signal: AbortSignal): Promise<PublicConfig> {
  const response = await fetch('/api/payment-center/config', { cache: 'no-store', signal });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.data) {
    throw new Error(payload?.error || `Payment Center config HTTP ${response.status}`);
  }
  const config = payload.data as PublicConfig;
  if (!config.baseUrl || !config.siteCode) {
    throw new Error('Payment Center public configuration is incomplete');
  }
  return config;
}

function waitForWidgetApi(signal: AbortSignal): Promise<WidgetApi> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const api = widgetApi();
      if (api) {
        clearInterval(timer);
        resolve(api);
        return;
      }
      if (signal.aborted) {
        clearInterval(timer);
        reject(new Error('Payment Center widget was cancelled'));
        return;
      }
      if (Date.now() - started > READY_TIMEOUT_MILLIS) {
        clearInterval(timer);
        reject(new Error('Payment Center widget did not load in time'));
      }
    }, POLL_INTERVAL_MILLIS);
  });
}

export function PaymentCenterCheckout({ productCode, billingInterval, catalogCurrency }: {
  productCode: string;
  billingInterval: string;
  catalogCurrency: string;
}) {
  const t = useTranslations('Pricing');
  const mountPoint = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    const element = mountPoint.current;
    if (!element) return;
    const controller = new AbortController();

    const createOrder = async (selection: WidgetSelection) => {
      const response = await fetch('/api/payment-center/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selection),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      }
      return payload;
    };

    void (async () => {
      try {
        const config = await readPublicConfig(controller.signal);
        loadWidgetScript(config);
        const api = await waitForWidgetApi(controller.signal);
        if (controller.signal.aborted) return;
        await api.mount(element, {
          baseUrl: config.baseUrl,
          siteCode: config.siteCode,
          tokenUrl: TOKEN_URL,
          allowedMethods: config.methods,
          productCode,
          // Locking the interval is what turns the widget from a plan browser
          // into a plain payment-method list: the remote script hides its own
          // interval field and quotes the price for this one combination.
          billingInterval,
          currency: catalogCurrency,
          signal: controller.signal,
          createOrder,
        });
        if (!controller.signal.aborted) setStatus('ready');
      } catch {
        if (!controller.signal.aborted) setStatus('failed');
      }
    })();

    return () => controller.abort();
  }, [productCode, billingInterval, catalogCurrency]);

  return (
    <div>
      {status === 'failed' && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t('widgetFailed')}</p>
      )}
      {status === 'loading' && (
        <p role="status" className="text-sm text-gray-500 dark:text-gray-400">{t('widgetLoading')}</p>
      )}
      {/* The remote widget owns everything inside this element. React must never
          render children here, or it would fight the script over the same DOM. */}
      <div ref={mountPoint} />
    </div>
  );
}
