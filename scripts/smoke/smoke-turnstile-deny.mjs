import 'dotenv/config';
import assert from 'node:assert/strict';
import postgres from 'postgres';

const base = process.env.APP_BASE_URL || 'http://localhost:3000';
const email = `saas-turnstile-deny-${Date.now()}@example.test`;
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: base,
      'x-captcha-response': 'XXXX.DUMMY.TOKEN.XXXX',
    },
    body: JSON.stringify({ name: 'Rejected User', email, password: 'LocalSmokePass123!' }),
  });
  assert.ok(response.status >= 400, `Siteverify failure was accepted (${response.status})`);
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM "user" WHERE email = ${email}`;
  assert.equal(count, 0, 'A rejected challenge created a user');
  console.log(`Human verification rejected registration (${response.status}) and created no user.`);
} finally {
  await sql.end({ timeout: 5 });
}
