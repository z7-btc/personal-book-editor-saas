import { features, getCapabilities } from '@/lib/config';
import {
  enabledMethods, getPaymentCatalog, methodCapabilities,
} from '@/lib/payment-center/catalog';
import { paymentCenterPublicConfig } from '@/lib/payment-center/embed';

export const dynamic = 'force-dynamic';

/**
 * Public identifiers the browser needs to load the remote Payment Center widget,
 * plus the payment methods this deployment has switched on. No API key, no
 * callback secret — everything here is safe to read from the page source.
 */
export async function GET() {
  if (!getCapabilities().paymentCenter.configured) {
    return Response.json({ error: 'payment_unavailable' }, { status: 503 });
  }
  try {
    const config = paymentCenterPublicConfig();
    // The catalogue is the channel list: every method with a capability card
    // and an enabled switch is offered, including one added after this deploy.
    // The only local filter left is the deployment's commission-balance flag.
    const catalog = await getPaymentCatalog();
    const methods = enabledMethods(catalog).filter((method) =>
      method !== 'commission_balance' || features.commissionBalance);
    // A redirect channel is fulfilled by the centre's subscription invoice,
    // which a one-time order never produces — the server refuses that pairing
    // (see `preparePaymentIntent`). The widget needs the action to hide the
    // button instead of offering one that can only fail.
    const capabilities = methodCapabilities(catalog);
    const methodActions = Object.fromEntries(
      methods.map((method) => [method, capabilities[method]?.action ?? '']));
    return Response.json({
      data: {
        baseUrl: config.baseUrl,
        siteCode: config.siteCode,
        methods,
        methodActions,
      },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'payment_unavailable' }, { status: 503 });
  }
}
