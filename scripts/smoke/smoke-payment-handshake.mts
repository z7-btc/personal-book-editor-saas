import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import postgres from 'postgres';

const base = process.env.APP_BASE_URL || 'http://localhost:3000';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname),
  'Handshake smoke must target a local SaaS server');
assert.ok(process.env.PAYMENT_CENTER_SITE_CODE?.startsWith('sf'),
  'Handshake smoke requires the dedicated local SaaS site');
assert.ok((process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET || '').length >= 32);

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const checkId = randomBytes(16).toString('hex');
const timestamp = String(Math.floor(Date.now() / 1000));
const body = JSON.stringify({
  event: 'handshake.check',
  check_id: checkId,
  site_code: process.env.PAYMENT_CENTER_SITE_CODE,
  modules: ['payment_pricing', 'referral', 'payment_callback'],
});
const signature = (time: string) => `sha256=${createHmac('sha256',
  process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET!)
  .update(`${time}.${body}`).digest('hex')}`;
const headers = (time: string) => ({
  'Content-Type': 'application/json',
  'X-Payment-Center-Timestamp': time,
  'X-Payment-Center-Signature': signature(time),
  'X-Payment-Center-Event': checkId,
  'X-Payment-Center-Site': process.env.PAYMENT_CENTER_SITE_CODE!,
});
const send = async (providedHeaders: Record<string, string>) => fetch(
  new URL('/api/payment-center/handshake', base), {
    method: 'POST', headers: providedHeaders, body, cache: 'no-store',
  }
);

try {
  const accepted = await send(headers(timestamp));
  assert.equal(accepted.status, 200, `Signed handshake failed: ${accepted.status}`);
  assert.equal(accepted.headers.get('cache-control'), 'no-store');
  const report = await accepted.json() as { data?: { modules?: Record<string, {
    status: string; issues: string[];
  }> } };
  // This smoke proves the endpoint's own guarantees: a signed challenge is
  // accepted once, a replay, a forgery, an expired timestamp and a foreign site
  // are refused, and the module report is coherent. Which modules are ready
  // depends on how far the local binding has been taken, so the statuses are
  // printed rather than pinned — but a module that claims `failed` must name at
  // least one issue, and no module may answer with anything but the two tokens
  // the Payment Center understands.
  const modules = report.data?.modules ?? {};
  for (const module of ['payment_pricing', 'referral', 'payment_callback']) {
    const state = modules[module];
    assert.ok(state, `Handshake report omitted ${module}`);
    assert.ok(['ready', 'failed'].includes(state.status),
      `${module} reported an unknown status: ${state.status}`);
    if (state.status === 'failed') {
      assert.ok(state.issues.length, `${module} failed without naming an issue`);
    }
    console.log(`  ${module}: ${state.status}${state.issues.length ? ` — ${state.issues.join('; ')}` : ''}`);
  }
  assert.equal((await send(headers(timestamp))).status, 409, 'Replay was accepted');
  assert.equal((await send({ ...headers(timestamp),
    'X-Payment-Center-Signature': `sha256=${'0'.repeat(64)}` })).status, 401,
  'Forged signature was accepted');
  const expired = String(Number(timestamp) - 301);
  assert.equal((await send(headers(expired))).status, 401, 'Expired challenge was accepted');
  assert.equal((await send({ ...headers(timestamp),
    'X-Payment-Center-Site': 'wrong-site' })).status, 401,
  'Wrong site was accepted');
  console.log('Signed local Payment Center handshake, module report coherence, replay and forgery checks passed.');
} finally {
  await sql`DELETE FROM payment_handshake_challenges WHERE check_id = ${checkId}`;
  await sql.end({ timeout: 5 });
}
