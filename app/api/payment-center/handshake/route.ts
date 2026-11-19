import { getCapabilities, features } from '@/lib/config';
import { client } from '@/lib/db/drizzle';
import { getPaymentCatalog } from '@/lib/payment-center/catalog';
import { verifyReferralBinding } from '@/lib/referrals/client';
import {
  InvalidPaymentHandshake,
  readHandshakeBody,
  verifyPaymentHandshake,
} from '@/lib/payment-center/handshake';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const noStore = { 'Cache-Control': 'no-store' };
type Module = { status: 'ready' | 'failed'; issues: string[] };
const failed = (issue: string): Module => ({ status: 'failed', issues: [issue] });

/**
 * The referral centre is connected only when its own key proves the binding:
 * the key authenticates and the answer names this website, active. The key's
 * permission list is not readable from here, so `withdrawal_create` stays the
 * Payment Center's own check.
 */
async function referralModule(): Promise<Module> {
  try {
    return (await verifyReferralBinding())
      ? { status: 'ready', issues: [] }
      : failed('返佣专属 Key 无法确认本站绑定，请检查 Key、网站标识与启用状态');
  } catch {
    return failed('无法连接返佣中心，请检查返佣中心地址与网络');
  }
}

export async function POST(request: Request) {
  if (!process.env.PAYMENT_CENTER_SITE_CODE ||
      (process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET || '').length < 32) {
    return Response.json({ error: 'handshake_unconfigured' },
      { status: 503, headers: noStore });
  }
  if (Number(request.headers.get('content-length') || 0) > 8_192) {
    return Response.json({ error: 'handshake_too_large' },
      { status: 413, headers: noStore });
  }

  let checkId: string;
  try {
    checkId = verifyPaymentHandshake(await readHandshakeBody(request), request.headers);
  } catch (error) {
    return Response.json({ error: error instanceof InvalidPaymentHandshake
      ? 'invalid_handshake' : 'handshake_unavailable' },
      { status: 401, headers: noStore });
  }

  try {
    await client`DELETE FROM payment_handshake_challenges WHERE expires_at < now()`;
    const inserted = await client`
      INSERT INTO payment_handshake_challenges (check_id, site_code, expires_at)
      VALUES (${checkId}, ${process.env.PAYMENT_CENTER_SITE_CODE!}, now() + interval '10 minutes')
      ON CONFLICT (check_id) DO NOTHING RETURNING check_id
    `;
    if (!inserted.length) {
      return Response.json({ error: 'replayed_handshake' },
        { status: 409, headers: noStore });
    }
  } catch {
    return Response.json({ error: 'handshake_unavailable' },
      { status: 503, headers: noStore });
  }

  const capabilities = getCapabilities();
  const [database, catalogResult] = await Promise.allSettled([
    client`SELECT 1`,
    capabilities.paymentCenter.configured ? getPaymentCatalog() : Promise.resolve(null),
  ]);
  const databaseReady = database.status === 'fulfilled';
  const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : null;
  const paymentPricing: Module = !capabilities.paymentCenter.configured
    ? failed('本站的 Payment Center 接入凭证尚未配置')
    : !catalog ? failed('无法通过网站专属 Key 读取商品目录')
      : !catalog.products.length ? failed('本站尚无可售商品与价格')
        : !catalog.methods.length ? failed('本站尚无可用付款方式')
          : { status: 'ready', issues: [] };

  let callback: Module = !databaseReady
    ? failed('本站数据库不可用，付款回调无法可靠入账')
    : !capabilities.paymentCenter.configured
      ? failed('本站的付款回调签名和网站绑定尚未配置')
      : failed('尚无最近七天经签名回调完成的付款及权益证据');
  if (databaseReady && capabilities.paymentCenter.configured) {
    try {
      const [proof] = await client`
        SELECT EXISTS (
          SELECT 1 FROM payment_inbox i
          JOIN payment_evidence e ON e.source_event_id = i.event_id
          JOIN subscription_grants g ON g.evidence_id = e.id
          WHERE i.website_id = ${process.env.PAYMENT_CENTER_WEBSITE_ID!}
            AND i.status = 'processed'
            AND i.received_at > now() - interval '7 days'
        ) AS proven
      `;
      if (proof?.proven) callback = { status: 'ready', issues: [] };
    } catch {
      callback = failed('付款回调与权益证据查询失败');
    }
  }

  const referral: Module = !features.referrals
    ? failed('返佣中心尚未启用')
    : !capabilities.referrals.configured
      ? failed(`返佣中心配置不完整：${capabilities.referrals.missing.join('、')}`)
      : await referralModule();

  return Response.json({ data: {
    site_version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || 'local',
    responded_at: new Date().toISOString(),
    required_product_codes: catalog?.products.map((product) => product.code) || [],
    modules: {
      payment_pricing: paymentPricing,
      referral,
      payment_callback: callback,
    },
  } }, { headers: noStore });
}
