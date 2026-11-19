import 'dotenv/config';
import assert from 'node:assert/strict';

process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.PAYMENT_CENTER_BASE_URL = 'https://payments.example.test';
process.env.PAYMENT_CENTER_API_KEY = 'mock-website-key';
process.env.PAYMENT_CENTER_SITE_CODE = 'saas-test';
process.env.PAYMENT_CENTER_WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = 'mock-callback-secret-longer-than-32-bytes';

const { queryCenterSubscription, setCenterAutoRenew } =
  await import('../../lib/payment-center/subscriptions');
const accountId = 'ba_123';
const subscriptionId = 'sub_456';
const expected = {
  order_id: '11111111-1111-4111-8111-111111111111',
  website_id: process.env.PAYMENT_CENTER_WEBSITE_ID,
  billing_account_id: accountId,
  provider_subscription_id: subscriptionId,
  status: 'active', cancel_at_period_end: false,
  current_period_end: 1_800_000_000,
};
const calls: string[] = [];
const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push(`${init?.method || 'GET'} ${url.pathname}`);
  assert.equal(url.origin, 'https://payments.example.test');
  assert.equal(new Headers(init?.headers).get('x-api-key'), 'mock-website-key');
  assert.equal(init?.cache, 'no-store');
  if (init?.method === 'POST') assert.deepEqual(JSON.parse(String(init.body)), { enabled: false });
  return Response.json({ status: 'success', data: {
    ...expected, cancel_at_period_end: init?.method === 'POST',
  } });
}) as typeof fetch;

assert.equal((await queryCenterSubscription(accountId, subscriptionId, send)).status, 'active');
assert.equal((await setCenterAutoRenew(accountId, subscriptionId, false, send))
  .cancel_at_period_end, true);
assert.deepEqual(calls, [
  'GET /api/payment-center/subscriptions/by-account/ba_123/sub_456',
  'POST /api/payment-center/subscriptions/by-account/ba_123/sub_456/auto-renew',
]);
await assert.rejects(queryCenterSubscription(accountId, subscriptionId,
  (async () => Response.json({ status: 'success', data: {
    ...expected, billing_account_id: 'ba_other',
  } })) as typeof fetch), /another account/);
await assert.rejects(queryCenterSubscription(accountId, subscriptionId,
  (async () => Response.json({ status: 'success', data: {
    ...expected, website_id: '00000000-0000-4000-8000-000000000002',
  } })) as typeof fetch), /another account/);
console.log('Workspace-scoped Payment Center subscription query and control passed.');
