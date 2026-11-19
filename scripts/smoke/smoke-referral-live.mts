import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import postgres from 'postgres';
import 'dotenv/config';

const base = process.env.APP_BASE_URL || 'http://localhost:3000';
if (process.env.NODE_ENV === 'production' ||
    base !== 'http://localhost:3000' ||
    process.env.PAYMENT_CENTER_BASE_URL !== 'http://127.0.0.1:5000' ||
    !/^sf[a-z0-9]+$/.test(process.env.PAYMENT_CENTER_SITE_CODE || '')) {
  throw new Error('This smoke requires local SaaS and Payment Center development servers.');
}
if (process.env.FEATURE_TURNSTILE === 'true') {
  console.error('[smoke:referral-live] blocked: the dev server runs with FEATURE_TURNSTILE=true, so an HTTP sign-up cannot obtain a token and this smoke cannot create its inviter/referred accounts. Run it against a local server started with FEATURE_TURNSTILE=false.');
  process.exit(2);
}

const pcValues = dotenv.parse(readFileSync(resolve('../../payment-center/.env')));
const pcDatabaseUrl = (pcValues.DATABASE_URL || '')
  .replace(/^postgresql\+psycopg2:/, 'postgres:');
if (!pcDatabaseUrl.includes('@127.0.0.1:5432/payment_center')) {
  throw new Error('Refusing to use a nonlocal Payment Center database.');
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const pc = postgres(pcDatabaseUrl, { max: 1 });
const suffix = randomUUID();
const emails = [
  `saas-referral-inviter-${suffix}@example.invalid`,
  `saas-referral-referred-${suffix}@example.invalid`,
];
const ids: string[] = [];
const siteId = process.env.PAYMENT_CENTER_WEBSITE_ID!;
process.env.FEATURE_REFERRALS = 'true';

function cookieHeader(response: Response) {
  return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
}

async function signup(email: string, name: string) {
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name, email, password: 'LocalReferralSmoke123!' }),
  });
  assert.equal(response.status, 200, `Sign-up failed: HTTP ${response.status}`);
  const cookie = cookieHeader(response);
  assert.ok(cookie);
  const sessionResponse = await fetch(`${base}/api/auth/get-session`, {
    headers: { Cookie: cookie },
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as { user: { id: string } };
  ids.push(session.user.id);
  return { id: session.user.id, cookie };
}

async function cleanup() {
  const remoteUsers = await pc`
    SELECT id, external_user_id FROM referral_users
    WHERE website_id = ${siteId} AND external_user_id IN (${ids[0] || ''}, ${ids[1] || ''})
  `;
  if (remoteUsers.length) {
    const remoteIds = remoteUsers.map((row) => row.id as string);
    await pc`DELETE FROM commission_balances WHERE referral_user_id IN ${pc(remoteIds)}`;
    if (ids[1]) await pc`
      DELETE FROM referral_users WHERE website_id = ${siteId} AND external_user_id = ${ids[1]}
    `;
    if (ids[0]) await pc`
      DELETE FROM referral_users WHERE website_id = ${siteId} AND external_user_id = ${ids[0]}
    `;
  }
  if (ids.length) {
    await sql`
      DELETE FROM organization WHERE id IN (
        SELECT organization_id FROM member WHERE user_id IN ${sql(ids)}
      )
    `;
    await sql`DELETE FROM "user" WHERE id IN ${sql(ids)}`;
  }
}

try {
  const [site] = await pc`
    SELECT id, settings->>'local_test_only' AS local_test_only
    FROM websites WHERE id = ${siteId}
  `;
  assert.equal(site?.local_test_only, 'true');
  const inviter = await signup(emails[0], 'Referral Inviter');
  const [created] = await sql`
    SELECT EXTRACT(EPOCH FROM created_at AT TIME ZONE 'UTC')::bigint AS utc_epoch
    FROM "user" WHERE id = ${inviter.id}
  `;
  const nowEpoch = Math.floor(Date.now() / 1_000);
  assert.ok(Math.abs(Number(created.utc_epoch) - nowEpoch) < 60,
    'Better Auth creation time must be read as a UTC-naive timestamp');
  const [profile] = await sql`
    SELECT invite_code FROM referral_profiles WHERE user_id = ${inviter.id}
  `;
  assert.match(profile.invite_code, /^SF[0-9A-F]{32}$/);

  const { runReferralUserSync } = await import('../../lib/referrals/worker');
  const inviterSync = await runReferralUserSync({ maxJobs: 2 });
  assert.equal(inviterSync.succeeded, 1);
  const { getReferralOverview } = await import('../../lib/referrals/overview');
  const captured: string[] = [];
  const mockSend: typeof fetch = async (input) => {
    const url = new URL(String(input));
    captured.push(url.pathname + url.search);
    const data = url.pathname.endsWith('/summary') ? {
      exists: true,
      user: { id: 'mock-remote-user', external_user_id: inviter.id, website_id: siteId },
      balance: {
        currency: 'USDT', available_amount_decimal: '0.00000001',
        verified_available_amount_decimal: '0.00000001',
        pending_amount_decimal: '2.00000000', withdrawn_amount_decimal: '0',
        total_earned_decimal: '2.00000001',
      },
      invite_count: 1, order_count: 0, tier: { name: 'Local test' }, next_tier: null,
      effective_rates: [{ channel: 'STRIPE', commission_rate: 0 }],
      maintenance_mode: false,
      withdrawal_enabled: true, withdrawal_minimum_amount_decimal: '50.00000000',
    } : url.pathname.endsWith('/withdrawals') ? {
      currency: 'USDT', withdrawals: [{
        id: 'smoke-withdrawal', website_id: siteId,
        referral_user_id: 'mock-remote-user', currency: 'USDT',
        status: 'requested', amount_decimal: '0.00000001',
        requested_at: new Date().toISOString(),
        payout_account: 'must-not-leak',
      }],
    } : {
      currency: 'USDT', ledger: [{
        id: 'smoke-ledger', website_id: siteId, currency: 'USDT',
        entry_type: 'commission_earned', amount_decimal: '0.00000001',
        balance_after_decimal: '0.00000001', created_at: new Date().toISOString(),
        metadata: { secret: 'must-not-leak' },
      }],
    };
    return Response.json({ status: 'success', data });
  };
  const mocked = await getReferralOverview(inviter.id, 0, 0, 0, mockSend);
  assert.equal(mocked.state, 'ready');
  if (mocked.state !== 'ready') throw new Error('Missing referral overview.');
  assert.equal(mocked.balance.available, '0.00000001');
  assert.equal(mocked.ledger[0]?.amount, '0.00000001');
  assert.equal(mocked.withdrawals[0]?.amount, '0.00000001');
  assert.ok(!JSON.stringify(mocked).includes('must-not-leak'));
  assert.ok(captured.some((path) => path.includes('/ledger?currency=USDT&limit=21&offset=0')));
  assert.ok(captured.some((path) => path.includes('/withdrawals?external_user_id=')));
  const dashboard = await fetch(`${base}/zh-CN/dashboard`, {
    headers: { Cookie: inviter.cookie },
  });
  assert.equal(dashboard.status, 200);
  assert.ok((await dashboard.text()).includes(`/zh-CN/invite/${profile.invite_code}`));

  const invitation = await fetch(`${base}/zh-CN/invite/${profile.invite_code}`, {
    redirect: 'manual',
  });
  assert.equal(invitation.status, 307);
  assert.ok(invitation.headers.get('location')?.endsWith('/zh-CN/sign-up'));
  const inviteCookie = cookieHeader(invitation);
  assert.match(inviteCookie, /saas_referral_invite=/);

  const referred = await signup(emails[1], 'Referral Referred');
  const claimCookie = `${inviteCookie}; ${referred.cookie}`;
  const claim = await fetch(`${base}/api/referrals/claim`, {
    method: 'POST',
    headers: { Cookie: claimCookie, Origin: base },
  });
  assert.equal(claim.status, 200, `Claim failed: HTTP ${claim.status}`);
  assert.equal((await claim.json()).status, 'claimed');
  const replay = await fetch(`${base}/api/referrals/claim`, {
    method: 'POST', headers: { Cookie: claimCookie, Origin: base },
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).status, 'already_claimed');

  const firstAttempt = await runReferralUserSync({
    maxJobs: 1,
    send: async () => { throw new Error('Simulated network failure'); },
  });
  assert.equal(firstAttempt.retried, 1);
  await sql`
    UPDATE referral_user_outbox SET available_at = now()
    WHERE user_id = ${referred.id} AND status = 'pending'
  `;
  const recovered = await runReferralUserSync({ maxJobs: 2 });
  assert.equal(recovered.succeeded, 1);
  const [remote] = await pc`
    SELECT child.invite_code, parent.external_user_id AS inviter_user_id
    FROM referral_users child
    JOIN referral_users parent ON parent.id = child.referred_by_id
    WHERE child.website_id = ${siteId} AND child.external_user_id = ${referred.id}
  `;
  assert.equal(remote?.inviter_user_id, inviter.id);
  const [local] = await sql`
    SELECT inviter_user_id, invite_code FROM referral_attributions
    WHERE user_id = ${referred.id}
  `;
  assert.equal(local?.inviter_user_id, inviter.id);
  assert.equal(local?.invite_code, profile.invite_code);
  const overviewResponse = await fetch(`${base}/api/referrals/overview?currency=USDT`, {
    headers: { Cookie: inviter.cookie },
  });
  assert.equal(overviewResponse.status, 200, `Overview HTTP ${overviewResponse.status}`);
  assert.equal(overviewResponse.headers.get('cache-control'), 'private, no-store');
  const overview = await overviewResponse.json() as { data: {
    state: string; currency: string; inviteCode: string; inviteCount: number;
    invitations: Array<{ email: string }>;
  } };
  assert.equal(overview.data.state, 'ready');
  assert.equal(overview.data.currency, 'USDT');
  assert.equal(overview.data.inviteCode, profile.invite_code);
  assert.equal(overview.data.inviteCount, 1);
  assert.equal(overview.data.invitations.length, 1);
  assert.ok(!JSON.stringify(overview).includes(emails[1]));
  const unauthenticated = await fetch(`${base}/api/referrals/overview?currency=USDT`);
  assert.equal(unauthenticated.status, 401);
  const spoofed = await fetch(`${base}/api/referrals/overview?currency=USDT&userId=${referred.id}`, {
    headers: { Cookie: inviter.cookie },
  });
  assert.equal(spoofed.status, 200);
  assert.equal((await spoofed.json()).data.inviteCode, profile.invite_code);
  const page = await fetch(`${base}/zh-CN/dashboard/referrals?currency=USDT`, {
    headers: { Cookie: inviter.cookie },
  });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('佣金流水'));
  assert.ok(html.includes('当前渠道返佣比例'));
  assert.ok(html.includes(`/zh-CN/invite/${profile.invite_code}`));
  assert.ok(!html.includes(emails[1]));
  console.log('Real HTTP referral signup, attribution, recovery, overview BFF and page passed.');
} finally {
  try { await cleanup(); } finally {
    const { client } = await import('../../lib/db/drizzle');
    await Promise.all([
      sql.end({ timeout: 5 }), pc.end({ timeout: 5 }), client.end({ timeout: 5 }),
    ]);
  }
}
