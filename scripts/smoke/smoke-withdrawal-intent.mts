import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import postgres from 'postgres';

if (process.env.NODE_ENV === 'production' ||
    process.env.APP_BASE_URL !== 'http://localhost:3000' ||
    !process.env.DATABASE_URL?.includes('@127.0.0.1:5432/saas_framework')) {
  throw new Error('This smoke may only use the isolated local SaaS database.');
}
process.env.FEATURE_REFERRALS = 'true';
process.env.FEATURE_REFERRAL_WITHDRAWALS = 'true';
process.env.FEATURE_TRANSACTIONAL_EMAIL = 'true';
process.env.RESEND_API_KEY = 'local-mock-only';
process.env.EMAIL_FROM = 'noreply@example.invalid';
process.env.PAYMENT_CENTER_WITHDRAWAL_API_KEY = 'local-mock-only';
process.env.REFERRAL_WITHDRAWAL_REQUEST_SECRET = 'local-mock-signing-secret-32-bytes-long';

const module = await import('../../lib/referrals/withdrawal-intent.ts');
const { prepareWithdrawalIntent, WithdrawalConflict,
  WithdrawalIdentityRequired, WithdrawalRecentAuthRequired } =
  (module as { default?: typeof module }).default ?? module;
const dbModule = await import('../../lib/db/drizzle.ts');
const appClient = ((dbModule as { default?: typeof dbModule }).default ?? dbModule).client;
const workerModule = await import('../../lib/referrals/withdrawal-worker.ts');
const { runWithdrawalDispatch } =
  (workerModule as { default?: typeof workerModule }).default ?? workerModule;
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const id = randomUUID();
const email = `saas-withdrawal-${id}@example.invalid`;
const account = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const input = {
  requestKey: randomUUID(), amount: '12.00000001', currency: 'USDT' as const,
  method: 'BLOCKCHAIN' as const, blockchain: 'BSC' as const,
  payoutAccount: account,
};
try {
  await sql`
    INSERT INTO "user" (id, name, email, email_verified)
    VALUES (${id}, 'Withdrawal smoke', ${email}, true)
  `;
  await sql`UPDATE referral_user_outbox SET status = 'succeeded' WHERE user_id = ${id}`;
  const user = { id, emailVerified: true };
  const first = await prepareWithdrawalIntent(user, new Date(), input);
  assert.equal(first.replay, false);
  assert.equal(first.intent.status, 'pending');
  assert.equal(first.intent.accountMask, '0x71c7…976f');
  const [stored] = await sql`
    SELECT account_ciphertext, account_fingerprint, amount_decimal
    FROM referral_withdrawal_intents WHERE id = ${first.intent.id}
  `;
  assert.equal(stored?.amount_decimal, '12.00000001');
  assert.ok(!String(stored?.account_ciphertext).includes(account.toLowerCase()));
  assert.match(String(stored?.account_fingerprint), /^[0-9a-f]{64}$/);
  const replay = await prepareWithdrawalIntent(user, new Date(), {
    ...input, payoutAccount: account.toLowerCase(), amount: '12.00000001',
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.intent.id, first.intent.id);
  await assert.rejects(prepareWithdrawalIntent(user, new Date(), {
    ...input, payoutAccount: `0x${'0'.repeat(40)}`,
  }), WithdrawalConflict);
  await assert.rejects(prepareWithdrawalIntent(
    { id, emailVerified: false }, new Date(), input,
  ), WithdrawalIdentityRequired);
  await assert.rejects(prepareWithdrawalIntent(
    user, new Date(Date.now() - 16 * 60_000), input,
  ), WithdrawalRecentAuthRequired);
  await assert.rejects(prepareWithdrawalIntent(user, new Date(), {
    ...input, requestKey: randomUUID(),
  }), WithdrawalConflict);
  let postCount = 0;
  const mockSend: typeof fetch = async (request, options) => {
    const url = new URL(String(request));
    if (url.pathname.endsWith('/summary')) return Response.json({
      status: 'success', data: { exists: true, user: {
        id: 'remote-user', external_user_id: id,
        website_id: process.env.PAYMENT_CENTER_WEBSITE_ID,
      } },
    });
    assert.equal(url.pathname, '/api/referral-center/withdrawals');
    postCount++;
    const headers = new Headers(options?.headers);
    const body = String(options?.body);
    const timestamp = headers.get('X-Withdrawal-Timestamp');
    const nonce = headers.get('X-Withdrawal-Nonce');
    const signature = createHmac('sha256', process.env.REFERRAL_WITHDRAWAL_REQUEST_SECRET!)
      .update(['POST', url.pathname, body, timestamp, nonce].join('\\n')).digest('hex');
    assert.equal(headers.get('X-Withdrawal-Signature'), signature);
    const requestBody = JSON.parse(body);
    assert.equal(requestBody.external_withdrawal_id, first.intent.id);
    assert.equal(requestBody.payout_account, account.toLowerCase());
    if (postCount === 1) throw new Error('Simulated result timeout');
    return Response.json({ status: 'success', data: {
      success: true, withdrawal: {
        id: 'remote-withdrawal', website_id: process.env.PAYMENT_CENTER_WEBSITE_ID,
        referral_user_id: 'remote-user', external_withdrawal_id: first.intent.id,
        amount_decimal: '12.00000001', currency: 'USDT', method: 'BLOCKCHAIN_BSC',
        payout_account: account.toLowerCase(),
      },
    } });
  };
  const uncertain = await runWithdrawalDispatch({
    requestedId: first.intent.id, send: mockSend,
  });
  assert.equal(uncertain.uncertain, 1);
  await sql`
    UPDATE referral_withdrawal_intents SET available_at = now()
    WHERE id = ${first.intent.id}
  `;
  const recovered = await runWithdrawalDispatch({
    requestedId: first.intent.id, send: mockSend,
  });
  assert.equal(recovered.submitted, 1);
  assert.equal(postCount, 2);
  const [settled] = await sql`
    SELECT status::text, center_withdrawal_id, attempt_count
    FROM referral_withdrawal_intents WHERE id = ${first.intent.id}
  `;
  assert.equal(settled.status, 'submitted');
  assert.equal(settled.center_withdrawal_id, 'remote-withdrawal');
  assert.equal(settled.attempt_count, 2);
  console.log('Encrypted withdrawal intent, signed dispatch, timeout recovery and auth gates passed.');
} finally {
  await sql`DELETE FROM referral_withdrawal_intents WHERE user_id = ${id}`;
  await sql`DELETE FROM organization WHERE id IN (
    SELECT organization_id FROM member WHERE user_id = ${id}
  )`;
  await sql`DELETE FROM "user" WHERE id = ${id}`;
  await Promise.all([sql.end({ timeout: 5 }), appClient.end({ timeout: 5 })]);
}
