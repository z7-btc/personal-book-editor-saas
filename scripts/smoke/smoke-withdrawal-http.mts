import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const base = 'http://localhost:3000';
if (process.env.NODE_ENV === 'production' || process.env.APP_BASE_URL !== base ||
    !process.env.DATABASE_URL?.includes('@127.0.0.1:5432/saas_framework')) {
  throw new Error('This smoke requires local SaaS only.');
}
if (process.env.PAYMENT_CENTER_BASE_URL !== 'http://127.0.0.1:4872' ||
    process.env.FEATURE_REFERRAL_WITHDRAWALS !== 'true') {
  console.error('[smoke:withdrawal-http] blocked: this smoke needs the mock withdrawal center (PAYMENT_CENTER_BASE_URL=http://127.0.0.1:4872) and FEATURE_REFERRAL_WITHDRAWALS=true; the current .env is not configured that way.');
  process.exit(2);
}
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const emails = [0, 1].map(() => `saas-withdrawal-http-${randomUUID()}@example.invalid`);
const ids: string[] = [];
function cookies(response: Response) {
  return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
}
async function signup(email: string) {
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Withdrawal HTTP smoke', email, password: 'WithdrawalHttpSmoke123!' }),
  });
  assert.equal(response.status, 200);
  const [user] = await sql`SELECT id FROM "user" WHERE email = ${email}`;
  assert.ok(user?.id);
  ids.push(user.id);
  return { id: String(user.id), cookie: cookies(response) };
}

try {
  const first = await signup(emails[0]);
  const requestKey = randomUUID();
  const request = {
    requestKey, amount: '5.00000000', currency: 'USDT',
    method: 'BINANCE_UID', blockchain: null, payoutAccount: '123456789',
  };
  const post = (cookie: string, body: unknown) => fetch(`${base}/api/referrals/withdrawals`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: base, Cookie: cookie,
    }, body: JSON.stringify(body),
  });
  assert.equal((await post('', request)).status, 401);
  const unverified = await post(first.cookie, request);
  assert.equal(unverified.status, 403);
  assert.equal((await unverified.json()).error, 'email_unconfirmed');
  await sql`UPDATE "user" SET email_verified = true WHERE id = ${first.id}`;
  await sql`UPDATE referral_user_outbox SET status = 'succeeded' WHERE user_id = ${first.id}`;
  const login = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: emails[0], password: 'WithdrawalHttpSmoke123!' }),
  });
  assert.equal(login.status, 200);
  const cookie = cookies(login);
  assert.ok(cookie);
  const page = await fetch(`${base}/zh-CN/dashboard/referrals?currency=USDT`, {
    headers: { Cookie: cookie },
  });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('申请提现'));

  const submitted = await post(cookie, request);
  assert.equal(submitted.status, 201, `Withdrawal HTTP ${submitted.status}`);
  assert.equal(submitted.headers.get('cache-control'), 'private, no-store');
  const submittedBody = await submitted.json();
  assert.equal(submittedBody.data.status, 'submitted');
  assert.equal(submittedBody.data.accountMask, '***6789');
  assert.ok(!JSON.stringify(submittedBody).includes('123456789'));
  const withdrawalId = submittedBody.data.id as string;
  const [stored] = await sql`
    SELECT account_ciphertext, status::text, attempt_count
    FROM referral_withdrawal_intents WHERE id = ${withdrawalId}
  `;
  assert.equal(stored.status, 'submitted');
  assert.equal(stored.attempt_count, 1);
  assert.ok(!String(stored.account_ciphertext).includes('123456789'));
  const replay = await post(cookie, request);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).data.id, withdrawalId);
  const conflict = await post(cookie, { ...request, payoutAccount: '987654321' });
  assert.equal(conflict.status, 409);
  const byKey = await fetch(`${base}/api/referrals/withdrawals?requestKey=${requestKey}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(byKey.status, 200);
  assert.equal((await byKey.json()).data.id, withdrawalId);
  const second = await signup(emails[1]);
  const otherUser = await fetch(`${base}/api/referrals/withdrawals/${withdrawalId}`, {
    headers: { Cookie: second.cookie },
  });
  assert.equal(otherUser.status, 404);
  console.log('Real HTTP withdrawal auth, signed mock dispatch, replay, isolation and masking passed.');
} finally {
  if (ids.length) {
    await sql`DELETE FROM referral_withdrawal_intents WHERE user_id IN ${sql(ids)}`;
    await sql`DELETE FROM organization WHERE id IN (
      SELECT organization_id FROM member WHERE user_id IN ${sql(ids)}
    )`;
    await sql`DELETE FROM "user" WHERE id IN ${sql(ids)}`;
  }
  await sql.end({ timeout: 5 });
}
