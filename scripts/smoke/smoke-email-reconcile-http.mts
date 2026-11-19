import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

// Run against the existing local servers. The SaaS server must have been
// started with RECOVERY_RUNNER_MODE=cron and the saved local CRON_SECRET.
// This smoke creates no identity, queue item, contact or email.
const site = new URL(process.env.APP_BASE_URL || 'http://localhost:3000');
const center = new URL(process.env.EMAIL_CENTER_URL || 'http://127.0.0.1:3100');
const database = new URL(process.env.DATABASE_URL || '');
for (const url of [site, center, database]) {
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Local services only');
}
for (const url of [site, center]) {
  assert.equal(url.pathname, '/');
  assert.equal(url.search + url.hash + url.username + url.password, '');
}
assert.notEqual(process.env.NODE_ENV, 'production');
const secret = process.env.CRON_SECRET || '';
assert.ok(secret.length >= 32, 'A configured local Cron secret is required');
assert.ok(process.env.EMAIL_CENTER_API_KEY, 'A configured local Email Center API key is required');
const sql = postgres(database.href, { max: 1 });
const wrongSecret = randomBytes(32).toString('hex');
const expected = {
  status: 'ok', report: {
    checked: 0, confirmed: 0, notReceived: 0, conflicts: 0, unreachable: 0, superseded: 0,
  },
};

function request(path: string, method: 'GET' | 'POST', bearer?: string, body?: string) {
  return fetch(new URL(path, site), {
    method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    }, ...(body !== undefined ? { body } : {}),
  });
}
async function emptyDatabase() {
  const [row] = await sql`SELECT (SELECT count(*)::integer FROM "user") AS users,
    (SELECT count(*)::integer FROM email_contact_outbox) AS events`;
  assert.equal(row.users, 0, 'Stop other SaaS fixtures and use an empty local database');
  assert.equal(row.events, 0, 'No queued contact operation may be present during the HTTP boundary test');
}
async function successful(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), expected);
}

try {
  await emptyDatabase();
  const route = '/api/internal/email-center/reconcile';
  for (const method of ['GET', 'POST'] as const) {
    for (const bearer of [undefined, wrongSecret]) {
      const response = await request(route, method, bearer);
      assert.equal(response.status, 401, `Cron ${method} requires the configured Bearer secret`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
    }
    await successful(await request(route, method, secret));
  }

  // The scheduler exposes no browser-controlled recovery operation. Query
  // parameters and POST bodies cannot select a user or grant a resend budget.
  const parameters = new URLSearchParams({
    force: 'true', retry: 'true', userId: 'nonexistent-local-fixture', eventVersion: '1',
  });
  await successful(await request(`${route}?${parameters}`, 'GET', secret));
  await successful(await request(`${route}?${parameters}`, 'POST', secret, JSON.stringify({
    force: true, retry: true, requeue: true, userId: 'nonexistent-local-fixture', eventVersion: 1,
  })));
  await successful(await request(route, 'POST', secret, '{"force":'));
  await emptyDatabase();

  const authorityResponse = await fetch(new URL('/api/v1/integrations/verify', center), {
    method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${process.env.EMAIL_CENTER_API_KEY}` },
  });
  assert.equal(authorityResponse.status, 200);
  const authority = await authorityResponse.json() as {
    data: { connected: boolean; applicationId: number; capabilities: { contactReconciliation: string } };
  };
  assert.equal(authority.data.connected, true);
  assert.ok(Number.isInteger(authority.data.applicationId) && authority.data.applicationId > 0);
  assert.equal(authority.data.capabilities.contactReconciliation, 'v1');

  const readyResponse = await request('/api/ready', 'GET');
  assert.equal(readyResponse.status, 200);
  assert.equal(readyResponse.headers.get('cache-control'), 'no-store');
  const ready = await readyResponse.json() as {
    status: string; database: string; modules: { emailApplication: string };
  };
  assert.equal(ready.status, 'ready');
  assert.equal(ready.database, 'ready');
  assert.equal(ready.modules.emailApplication, 'reachable', 'Readiness must recognize the live reconciliation v1 contract');

  for (const path of ['/api/auth/organization/list', '/api/auth/admin/list-users', '/api/auth/%6frganization/list']) {
    for (const method of ['GET', 'POST'] as const) {
      const response = await request(path, method, undefined, method === 'POST' ? '{}' : undefined);
      assert.equal(response.status, 404, 'Canceled organization and admin surfaces must remain unavailable');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'not_found' });
    }
  }
  await emptyDatabase();
  console.log('Local Email Center reconciliation HTTP checks passed: Cron GET/POST authorization, no-store empty reports, ignored recovery parameters/body, live v1 readiness and canceled organization/admin surfaces. No identities or messages were created.');
} finally {
  await sql.end({ timeout: 5 });
}
