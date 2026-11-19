import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import 'dotenv/config';

const base = 'http://localhost:3000';
if (process.env.NODE_ENV === 'production' || process.env.APP_BASE_URL !== base) {
  throw new Error('This smoke requires local SaaS only.');
}
if (process.env.TRANSACTIONAL_EMAIL_API_URL !== 'http://127.0.0.1:4871/emails' ||
    process.env.FEATURE_TRANSACTIONAL_EMAIL !== 'true' ||
    process.env.FEATURE_TURNSTILE === 'true') {
  console.error('[smoke:password-reset-live] blocked: the dev server must run with the mock transactional mail adapter (TRANSACTIONAL_EMAIL_API_URL=http://127.0.0.1:4871/emails, FEATURE_TRANSACTIONAL_EMAIL=true) and FEATURE_TURNSTILE=false so this smoke can request a reset and read the link; the current .env is not configured that way.');
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const email = `saas-reset-${randomUUID()}@example.invalid`;
const oldPassword = 'LocalResetOld123!';
const newPassword = 'LocalResetNew456!';
let userId: string | null = null;
try {
  const signup = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name: 'Password reset smoke', email, password: oldPassword }),
  });
  assert.equal(signup.status, 200);
  const cookie = signup.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const [account] = await sql`SELECT id FROM "user" WHERE email = ${email}`;
  userId = account.id;

  const badRedirect = await fetch(`${base}/api/auth/request-password-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email, redirectTo: 'https://wrong.example.invalid/reset-password' }),
  });
  assert.equal(badRedirect.status, 403);
  const request = await fetch(`${base}/api/auth/request-password-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email, redirectTo: `${base}/zh-CN/reset-password` }),
  });
  assert.equal(request.status, 200, `Reset request HTTP ${request.status}`);
  const delivery = await fetch('http://127.0.0.1:4871/latest');
  const capture = await delivery.json() as { mail: { to: string[]; text: string } | null };
  assert.deepEqual(capture.mail?.to, [email]);
  const link = capture.mail?.text.match(/https?:\/\/[^\s]+/)?.[0];
  assert.ok(link);
  const resetLink = new URL(link);
  assert.equal(resetLink.origin, base);
  assert.equal(resetLink.searchParams.get('callbackURL'), `${base}/zh-CN/reset-password`);
  const redirect = await fetch(link, { redirect: 'manual' });
  assert.ok([302, 307].includes(redirect.status));
  const destination = new URL(redirect.headers.get('location')!, base);
  assert.equal(destination.pathname, '/zh-CN/reset-password');
  const token = destination.searchParams.get('token');
  assert.ok(token);

  const reset = await fetch(`${base}/api/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ token, newPassword }),
  });
  assert.equal(reset.status, 200, `Reset HTTP ${reset.status}`);
  const replay = await fetch(`${base}/api/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ token, newPassword }),
  });
  assert.equal(replay.status, 400);
  const priorSession = await fetch(`${base}/api/auth/get-session`, { headers: { Cookie: cookie } });
  const priorBody = await priorSession.json();
  assert.equal(priorBody, null);
  const oldLogin = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email, password: oldPassword }),
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email, password: newPassword }),
  });
  assert.equal(newLogin.status, 200);
  console.log('Local reset mail, callback, single-use token, session revocation and new login passed.');
} finally {
  if (userId) {
    await sql`DELETE FROM organization WHERE id IN (
      SELECT organization_id FROM member WHERE user_id = ${userId}
    )`;
    await sql`DELETE FROM "user" WHERE id = ${userId}`;
  }
  await sql.end({ timeout: 5 });
}
