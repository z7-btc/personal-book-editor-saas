import 'dotenv/config';
import assert from 'node:assert/strict';

const base = process.env.PAYMENT_CENTER_BASE_URL || '';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname),
  'Payment binding smoke must target local Payment Center');
assert.ok(process.env.PAYMENT_CENTER_SITE_CODE?.startsWith('sf'),
  'Payment binding smoke requires the dedicated local SaaS site');
assert.ok(process.env.PAYMENT_CENTER_WEBSITE_ID && process.env.PAYMENT_CENTER_API_KEY);

// The local website is still intentionally disabled for user-facing checkout.
// Enable the client only in this process to verify the scoped server key.
process.env.FEATURE_PAYMENT_CENTER = 'true';
const { getPaymentCatalog } = await import('../../lib/payment-center/catalog');
const catalog = await getPaymentCatalog();
assert.equal(catalog.website_id, process.env.PAYMENT_CENTER_WEBSITE_ID);
assert.equal(catalog.site_code, process.env.PAYMENT_CENTER_SITE_CODE);
console.log(`Local SaaS Payment Center catalog binding passed; ${catalog.products.length} products, ${catalog.methods.length} methods currently available.`);
