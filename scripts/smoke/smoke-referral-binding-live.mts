import assert from 'node:assert/strict';
import 'dotenv/config';

if (process.env.NODE_ENV === 'production' ||
    !/^http:\/\/127\.0\.0\.1:5000\/?$/.test(process.env.PAYMENT_CENTER_BASE_URL || '') ||
    !/^sf[a-z0-9]+$/.test(process.env.PAYMENT_CENTER_SITE_CODE || '')) {
  throw new Error('This check is restricted to the local SaaS Payment Center site.');
}
process.env.FEATURE_REFERRALS = 'true';
const { verifyReferralBinding } = await import('../../lib/referrals/client');
assert.equal(await verifyReferralBinding(), true);
const url = new URL('/api/referral-center/attribution', process.env.PAYMENT_CENTER_BASE_URL);
url.searchParams.set('invite_code', 'INVALID-LOCAL-CODE');
const response = await fetch(url, {
  headers: { 'X-API-Key': process.env.PAYMENT_CENTER_REFERRAL_API_KEY! },
  cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000),
});
assert.equal(response.status, 200);
const body = await response.json() as { data?: { valid?: boolean } };
assert.equal(body.data?.valid, false);
console.log('Local SaaS referral key is bound to its own Payment Center site; attribution lookup is reachable.');
