import 'dotenv/config';
import assert from 'node:assert/strict';
import postgres from 'postgres';

const base = process.env.APP_BASE_URL || 'http://localhost:3000';
const email = `saas-smoke-${Date.now()}@example.test`;
const password = 'LocalSmokePass123!';
const turnstileToken = process.env.SMOKE_TURNSTILE_TOKEN;
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

function cookieHeader(response) {
  return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
}

try {
  const root = await fetch(base, { redirect: 'manual' });
  assert.equal(root.status, 307, 'Root should redirect to a locale');
  assert.equal(root.headers.get('location'), '/zh-CN');
  assert.match(root.headers.get('vary') || '', /Cookie/i);
  assert.match(root.headers.get('vary') || '', /Accept-Language/i);
  const browserEnglish = await fetch(base, {
    redirect: 'manual',
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  assert.equal(browserEnglish.headers.get('location'), '/en');
  const cookieChinese = await fetch(base, {
    redirect: 'manual',
    headers: { Cookie: 'NEXT_LOCALE=zh-CN', 'Accept-Language': 'en-US' },
  });
  assert.equal(cookieChinese.headers.get('location'), '/zh-CN');
  const page = await fetch(`${base}/en/sign-up`, { redirect: 'manual' });
  assert.equal(page.status, 200, 'English sign-up page should render');
  assert.ok((await page.text()).includes('Create your account'));
  const chinese = await fetch(`${base}/zh-CN/sign-up`, { redirect: 'manual' });
  assert.equal(chinese.status, 200, 'Chinese sign-up page should render');
  assert.ok((await chinese.text()).includes('创建账户'));

  if (turnstileToken) {
    const rejected = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ name: 'Smoke User', email, password, preferredLocale: 'en', localeSource: 'browser_detected', marketingOptInRequested: true }),
    });
    assert.ok(rejected.status >= 400, 'Turnstile accepted a missing token');
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM "user" WHERE email = ${email}`;
    assert.equal(count, 0, 'Rejected challenges must not create a user');
  }

  const signup = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: base,
      ...(turnstileToken ? { 'x-captcha-response': turnstileToken } : {}),
    },
    body: JSON.stringify({ name: 'Smoke User', email, password, preferredLocale: 'en', localeSource: 'browser_detected', marketingOptInRequested: true }),
  });
  assert.equal(signup.status, 200, `Sign-up failed: ${signup.status}`);
  const cookie = cookieHeader(signup);
  assert.ok(cookie, 'Sign-up did not set a session cookie');

  const sessionResponse = await fetch(`${base}/api/auth/get-session`, {
    headers: { Cookie: cookie },
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.user.email, email);
  assert.equal(session.user.emailVerified, false, 'Turnstile must not verify email ownership');
  assert.equal(session.user.preferredLocale, 'en');
  assert.equal(session.user.marketingOptInRequested, true);

  for (const [method, endpoint] of [
    ['GET', 'list'], ['GET', 'get-full-organization'], ['GET', 'get-invitation'],
    ['POST', 'create'], ['POST', 'invite-member'], ['POST', 'accept-invitation'],
    ['POST', 'remove-member'], ['POST', 'update-member-role'], ['POST', 'set-active'],
  ]) {
    const response = await fetch(`${base}/api/auth/organization/${endpoint}`, {
      method,
      headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    assert.equal(response.status, 404, `Public organization ${endpoint} must be disabled`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }

  for (const [method, endpoint] of [
    ['GET', 'admin/list-users'], ['POST', 'admin/set-role'],
    ['POST', 'admin/ban-user'], ['POST', 'admin/impersonate-user'],
    ['POST', 'change-email'],
  ]) {
    const response = await fetch(`${base}/api/auth/${endpoint}`, {
      method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    assert.equal(response.status, 404, `Unwanted or unprotected ${endpoint} must be disabled`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }

  if (process.env.FEATURE_PAYMENT_CENTER !== 'true') {
    const unavailablePayment = await fetch(`${base}/api/payment-center/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
      body: JSON.stringify({
        planKey: 'pro:month:USD', method: 'manual', requestKey: crypto.randomUUID(),
      }),
    });
    assert.equal(unavailablePayment.status, 503,
      'An unconfigured Payment Center must not create a payment intent');
  }

  const registrationEvents = await sql`
    SELECT event_version, status FROM email_contact_outbox WHERE user_id = ${session.user.id}
  `;
  assert.deepEqual(registrationEvents.map((event) => event.event_version), [1],
    'Registration and contact outbox should commit together');

  const localeChange = await fetch(`${base}/api/auth/update-user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
    body: JSON.stringify({ preferredLocale: 'zh-CN', localeSource: 'user_selected' }),
  });
  assert.equal(localeChange.status, 200, `Locale update failed: ${localeChange.status}`);
  const changeEvents = await sql`
    SELECT event_version FROM email_contact_outbox WHERE user_id = ${session.user.id} ORDER BY event_version
  `;
  assert.deepEqual(changeEvents.map((event) => event.event_version), [1, 2],
    'User preference change should create the next contact event');

  const dashboards = await Promise.all([0, 1].map(() => fetch(`${base}/en/dashboard`, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  })));
  for (const dashboard of dashboards) {
    assert.equal(dashboard.status, 200, `Dashboard failed: ${dashboard.status}`);
    const html = await dashboard.text();
    assert.ok(html.includes('Smoke User'));
    assert.ok(html.includes('My account'));
    assert.ok(!html.includes('Team &amp; workspaces'));
    assert.ok(!html.includes('/dashboard/workspaces'));
  }
  for (const removed of ['/en/dashboard/workspaces', '/en/accept-invitation/test-invitation']) {
    assert.equal((await fetch(`${base}${removed}`, { headers: { Cookie: cookie } })).status, 404);
  }

  const workspaceCount = await sql`
    SELECT count(*)::int AS count FROM organization o
    JOIN member m ON m.organization_id = o.id
    WHERE m.user_id = ${session.user.id} AND o.slug = ${`personal-${session.user.id.toLowerCase().replace(/[^a-z0-9]/g, '')}`}
  `;
  assert.equal(workspaceCount[0].count, 1, 'Concurrent bootstrap created duplicate workspaces');

  const signin = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: base,
      ...(turnstileToken ? { 'x-captcha-response': turnstileToken } : {}),
    },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(signin.status, 200, `Password sign-in failed: ${signin.status}`);
  assert.ok(cookieHeader(signin), 'Sign-in did not set a session cookie');
  console.log('Personal auth, contact outbox, idempotent billing bootstrap, disabled team/admin endpoints and protected email-change entry passed.');
} finally {
  const [user] = await sql`SELECT id FROM "user" WHERE email = ${email}`;
  if (user) {
    await sql`DELETE FROM organization WHERE id IN (SELECT organization_id FROM member WHERE user_id = ${user.id})`;
    await sql`DELETE FROM "user" WHERE id = ${user.id}`;
  }
  await sql.end({ timeout: 5 });
}
