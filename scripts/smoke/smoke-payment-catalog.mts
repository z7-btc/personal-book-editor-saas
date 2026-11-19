import assert from 'node:assert/strict';

process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.PAYMENT_CENTER_BASE_URL = 'https://payments.example.test';
process.env.PAYMENT_CENTER_API_KEY = 'mock-website-key';
process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = 'mock-callback-secret-longer-than-32-bytes';
process.env.PAYMENT_CENTER_SITE_CODE = 'saas-test';
process.env.PAYMENT_CENTER_WEBSITE_ID = '00000000-0000-4000-8000-000000000001';

const { getPaymentCatalog } = await import('../../lib/payment-center/catalog');
const catalog = {
  website_id: '00000000-0000-4000-8000-000000000001',
  site_code: 'saas-test',
  site_name: 'SaaS Test',
  methods: ['stripe', 'manual', 'blockchain', 'commission_balance'],
  unavailable_methods: { blockchain: 'monitor_unavailable' },
  products: [{
    code: 'pro',
    name: 'Pro',
    description: null,
    prices: [{ interval: 'month', amount: 15, amount_decimal: '15.00000000', currency: 'USD' }],
  }],
};

const send = (async (input: string | URL | Request, init?: RequestInit) => {
  assert.equal(new URL(String(input)).pathname, '/api/payment-center/catalog');
  assert.equal(new Headers(init?.headers).get('x-api-key'), 'mock-website-key');
  assert.equal(init?.cache, 'no-store');
  return Response.json({ status: 'success', data: catalog });
}) as typeof fetch;

assert.equal((await getPaymentCatalog(send)).products[0].code, 'pro');

process.env.PAYMENT_CENTER_SITE_CODE = 'another-site';
await assert.rejects(getPaymentCatalog(send), /different website/);
process.env.PAYMENT_CENTER_SITE_CODE = 'saas-test';

process.env.PAYMENT_CENTER_WEBSITE_ID = '00000000-0000-4000-8000-000000000002';
await assert.rejects(getPaymentCatalog(send), /unexpected website ID/);
process.env.PAYMENT_CENTER_WEBSITE_ID = '00000000-0000-4000-8000-000000000001';

const wrongAmount = (async () => Response.json({
  status: 'success',
  data: { ...catalog, products: [{ ...catalog.products[0], prices: [
    { interval: 'month', amount: -1, amount_decimal: '-1', currency: 'USD' },
  ] }] },
})) as typeof fetch;
await assert.rejects(getPaymentCatalog(wrongAmount), /response is invalid/);

console.log('Payment Center catalog key, site binding and response validation passed.');
