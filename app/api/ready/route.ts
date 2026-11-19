import { client } from '@/lib/db/drizzle';
import { getCapabilities } from '@/lib/config';
import { verifyEmailCenterConnection } from '@/lib/email-center/heartbeat';
import { reportCapabilities } from '@/lib/observability/capabilities';
import { getPaymentCatalog } from '@/lib/payment-center/catalog';
import { verifyReferralBinding } from '@/lib/referrals/client';

export const dynamic = 'force-dynamic';

type Check = 'disabled' | 'unconfigured' | 'reachable' | 'unreachable';

export async function GET() {
  const capabilities = getCapabilities();
  const checked = await Promise.allSettled([
    client`SELECT 1`,
    capabilities.paymentCenter.configured ? getPaymentCatalog() : Promise.resolve(null),
    // 同一个探活函数也是常驻 runner 的保活心跳（见 lib/jobs/background.ts）：
    // 健康报告和"牌子是不是绿的"必须给同一个答案，所以只有这一份判据。
    // 它失败是抛错，这里收成一个 `false`——`allSettled` 的 rejected 也一样看待。
    capabilities.emailCenter.configured
      ? verifyEmailCenterConnection().then(() => true, () => false)
      : Promise.resolve(null),
    capabilities.referrals.configured ? verifyReferralBinding() : Promise.resolve(null),
  ]);
  const databaseReady = checked[0].status === 'fulfilled';
  const payment: Check = !capabilities.paymentCenter.enabled ? 'disabled'
    : !capabilities.paymentCenter.configured ? 'unconfigured'
      : checked[1].status === 'fulfilled' ? 'reachable' : 'unreachable';
  const email: Check = !capabilities.emailCenter.enabled ? 'disabled'
    : !capabilities.emailCenter.configured ? 'unconfigured'
      : checked[2].status === 'fulfilled' && checked[2].value === true
        ? 'reachable' : 'unreachable';
  const referral: Check = !capabilities.referrals.enabled ? 'disabled'
    : !capabilities.referrals.configured ? 'unconfigured'
      : checked[3].status === 'fulfilled' && checked[3].value === true
        ? 'reachable' : 'unreachable';

  // A capability the deployment switched on but never wired up is the failure
  // this endpoint exists to surface, so it is recorded as an observation rather
  // than added to the body: the readiness contract stays exactly `status`,
  // `database` and `modules`, and an anonymous caller learns nothing about
  // which provider keys this deployment holds.
  reportCapabilities();

  return Response.json({
    status: databaseReady ? 'ready' : 'unavailable',
    database: databaseReady ? 'ready' : 'unavailable',
    modules: {
      paymentCatalog: payment,
      emailApplication: email,
      referralSite: referral,
    },
  }, {
    status: databaseReady ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
