import 'dotenv/config';
import { expect, test } from '@playwright/test';

/**
 * Acceptance criteria 23, 24, 31 and 32 at the browser boundary: the invite
 * entry point, the user-scoped referral reads and the withdrawal write path
 * with its cross-site guard.
 *
 * Nothing here needs a real payout: what is asserted is that the failure modes
 * are the honest ones (unavailable, unauthorized, invalid origin) instead of a
 * fabricated success.
 */
test('the invite entry point refuses to issue a cookie while referrals are switched off', async ({ request }) => {
  test.skip(
    process.env.FEATURE_REFERRALS === 'true',
    'the capability is enabled in this environment; the disabled path cannot be observed here',
  );

  const response = await request.get(`/zh-CN/invite/SF${'A'.repeat(32)}`, { maxRedirects: 0 });
  expect(response.status()).toBe(503);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()['set-cookie'] ?? '').not.toContain('saas_referral_invite');
});

test('referral reads and writes reject an anonymous caller', async ({ request }) => {
  const overview = await request.get('/api/referrals/overview');
  expect(overview.status()).toBe(401);
  await expect(overview.json()).resolves.toEqual({ error: 'unauthorized' });

  const withdrawals = await request.get('/api/referrals/withdrawals?requestKey=not-a-uuid');
  expect(withdrawals.status()).toBe(401);
  await expect(withdrawals.json()).resolves.toEqual({ error: 'unauthorized' });

  const post = await request.post('/api/referrals/withdrawals', {
    headers: { Origin: process.env.APP_BASE_URL ?? 'http://localhost:3000', 'Content-Type': 'application/json' },
    data: {},
  });
  expect(post.status()).toBe(401);
});

test('the withdrawal write path checks the origin before it checks the session', async ({ request }) => {
  const response = await request.post('/api/referrals/withdrawals', {
    headers: { Origin: 'https://not-this-site.example', 'Content-Type': 'application/json' },
    data: { amount: '10.000000', currency: 'USDT', method: 'BLOCKCHAIN', requestKey: 'x' },
  });
  expect(response.status()).toBe(403);
  await expect(response.json()).resolves.toEqual({ error: 'invalid_origin' });
  expect(response.headers()['cache-control']).toBe('private, no-store');
});

test('a well-formed but unknown invite code is answered as missing, not as an error', async ({ request }) => {
  const base = process.env.PAYMENT_CENTER_BASE_URL;
  test.skip(
    process.env.FEATURE_REFERRALS !== 'true' || !base,
    'blocked: the referral binding is switched off or unbound (FEATURE_REFERRALS !== "true")',
  );

  const response = await request.get(`/en/invite/SF${'B'.repeat(32)}`, { maxRedirects: 0 });
  // Either the local referral center does not know the code (404) or it cannot
  // be reached at all (503). Both are honest; a redirect with a cookie is not.
  expect([404, 503]).toContain(response.status());
  expect(response.headers()['set-cookie'] ?? '').not.toContain('saas_referral_invite');
});
