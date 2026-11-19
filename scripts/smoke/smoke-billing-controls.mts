import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import postgres from 'postgres';

const databaseUrl = new URL(process.env.DATABASE_URL || '');
if (databaseUrl.hostname !== '127.0.0.1' || databaseUrl.port !== '5432' ||
    databaseUrl.pathname !== '/saas_framework') {
  throw new Error('This smoke test requires the isolated local SaaS PostgreSQL database');
}
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const websiteId = '00000000-0000-4000-8000-000000000001';
const centerOrderId = randomUUID();
const subscriptionId = `sub_${randomUUID()}`;
const suffix = randomUUID();
const email = `billing-control-${suffix}@example.test`;
const otherEmail = `billing-other-${suffix}@example.test`;
const accountId = `ba_${suffix}`;
const intentId = `pi_${suffix}`;
const evidenceId = `pe_${suffix}`;
const grantId = `sg_${suffix}`;
let ownerId: string | null = null;
let otherId: string | null = null;
let organizationId: string | null = null;
let child: ChildProcess | null = null;
let center: Server | null = null;
let cancelAtPeriodEnd = false;
let wrongOrder = false;
let wrongWriteOrder = false;
let failAfterUpdate = false;
let postCount = 0;

function cookieHeader(response: Response) {
  return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
}

async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolveReady) => listener.listen(0, '127.0.0.1', resolveReady));
  const port = (listener.address() as AddressInfo).port;
  await new Promise<void>((resolveReady) => listener.close(() => resolveReady()));
  return port;
}

try {
  center = createServer(async (request, response) => {
    if (request.headers['x-api-key'] !== 'local-billing-smoke-key' ||
        !request.url?.startsWith(`/api/payment-center/subscriptions/by-account/${accountId}/${subscriptionId}`)) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === 'POST') {
      postCount++;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const { enabled } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      cancelAtPeriodEnd = !enabled;
      if (failAfterUpdate) {
        failAfterUpdate = false;
        response.writeHead(503).end();
        return;
      }
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'success', data: {
      order_id: wrongOrder || (request.method === 'POST' && wrongWriteOrder)
        ? randomUUID() : centerOrderId,
      website_id: websiteId,
      billing_account_id: accountId,
      provider_subscription_id: subscriptionId,
      status: 'active', cancel_at_period_end: cancelAtPeriodEnd,
      current_period_end: Math.floor(Date.now() / 1000) + 2_592_000,
    } }));
  });
  await new Promise<void>((resolveReady) => center!.listen(0, '127.0.0.1', resolveReady));
  const centerPort = (center.address() as AddressInfo).port;
  const appPort = await freePort();
  const appBase = `http://127.0.0.1:${appPort}`;
  child = spawn(process.execPath, [resolve(import.meta.dirname, '../node_modules/next/dist/bin/next'),
    'dev', '-p', String(appPort)], {
    cwd: resolve(import.meta.dirname, '..'), windowsHide: true,
    env: {
      ...process.env,
      APP_BASE_URL: appBase,
      FEATURE_PAYMENT_CENTER: 'true',
      PAYMENT_CENTER_BASE_URL: `http://127.0.0.1:${centerPort}`,
      PAYMENT_CENTER_API_KEY: 'local-billing-smoke-key',
      PAYMENT_CENTER_SITE_CODE: 'saas-smoke',
      PAYMENT_CENTER_WEBSITE_ID: websiteId,
      PAYMENT_CENTER_CALLBACK_SIGNING_SECRET: 'local-billing-smoke-secret-longer-than-32-bytes',
      FEATURE_TURNSTILE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-2_000); });
  child.stderr?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-2_000); });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) {
      if (/Another next dev server is already running/.test(output)) {
        console.error('[smoke:billing-controls] blocked: another `next dev` for this project is already running, so this smoke cannot start its own isolated server on a private port. Stop that dev server and re-run.');
        process.exit(2);
      }
      throw new Error(`SaaS dev server exited: ${output}`);
    }
    try {
      ready = (await fetch(`${appBase}/api/health`)).ok;
      if (ready) break;
    } catch { /* starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  assert.ok(ready, `SaaS dev server did not start: ${output}`);

  async function signUp(address: string) {
    const response = await fetch(`${appBase}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: appBase },
      body: JSON.stringify({ name: 'Billing Smoke', email: address, password: 'LocalSmokePass123!' }),
    });
    assert.equal(response.status, 200, `Sign-up failed: ${response.status}`);
    return cookieHeader(response);
  }
  const ownerCookie = await signUp(email);
  const otherCookie = await signUp(otherEmail);
  [{ id: ownerId }] = await sql`SELECT id FROM "user" WHERE email = ${email}`;
  [{ id: otherId }] = await sql`SELECT id FROM "user" WHERE email = ${otherEmail}`;
  assert.ok(ownerId && otherId);
  const dashboard = await fetch(`${appBase}/en/dashboard`, { headers: { Cookie: ownerCookie } });
  assert.equal(dashboard.status, 200);
  [{ organization_id: organizationId }] = await sql`
    SELECT organization_id FROM member WHERE user_id = ${ownerId} LIMIT 1`;
  assert.ok(organizationId);
  // A stale or tampered active organization must not select someone else's bill.
  await sql`UPDATE session SET active_organization_id = ${organizationId}
    WHERE user_id IN (${ownerId}, ${otherId})`;

  const endpoint = `${appBase}/api/payment-center/subscription`;
  const get = (cookie: string) => fetch(endpoint, { headers: { Cookie: cookie } });
  const post = (cookie: string, enabled: boolean, origin = appBase) => fetch(endpoint, {
    method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  assert.equal((await get(ownerCookie)).status, 404, 'Missing paid grant must not expose a control');

  await sql`INSERT INTO billing_accounts
    (id, organization_id, external_billing_id, original_payer_user_id)
    VALUES (${accountId}, ${organizationId}, ${accountId}, ${ownerId})`;
  await sql`INSERT INTO payment_intents
    (id, organization_id, billing_account_id, payer_user_id, request_key,
     product_code, price_interval, amount_decimal, currency, method, payment_action,
     external_order_id, idempotency_key, status, payment_center_order_id)
    VALUES (${intentId}, ${organizationId}, ${accountId}, ${ownerId}, ${randomUUID()},
      'pro', 'month', '15.00000000', 'USD', 'stripe', 'redirect', ${intentId}, ${intentId},
      'settled', ${centerOrderId})`;
  await sql`INSERT INTO payment_evidence
    (id, website_id, organization_id, intent_id, evidence_key, source_event_id,
     center_order_id, provider_subscription_id, provider_invoice_id, provider_payment_id,
     amount_decimal, currency, settled_at, service_period_start, service_period_end)
    VALUES (${evidenceId}, ${websiteId}, ${organizationId}, ${intentId},
      ${`invoice:${suffix}`}, ${randomUUID()}, ${centerOrderId}, ${subscriptionId},
      ${`in_${suffix}`}, ${`pay_${suffix}`}, '15.00000000', 'USD', now(),
      now() - interval '1 day', now() + interval '29 days')`;
  await sql`INSERT INTO subscription_grants
    (id, organization_id, evidence_id, product_code, payment_method,
     provider_subscription_id, period_start, period_end)
    VALUES (${grantId}, ${organizationId}, ${evidenceId}, 'pro', 'stripe',
      ${subscriptionId}, now() - interval '1 day', now() + interval '29 days')`;
  await sql`INSERT INTO subscriptions
    (organization_id, product_code, payment_method, provider_subscription_id, status, active_until)
    VALUES (${organizationId}, 'pro', 'stripe', ${subscriptionId}, 'active',
      now() + interval '29 days')`;

  const billingPage = await fetch(`${appBase}/en/dashboard/billing`, {
    headers: { Cookie: ownerCookie },
  });
  assert.equal(billingPage.status, 200);
  const pageHtml = await billingPage.text();
  assert.ok(pageHtml.includes('Billing and renewal'));
  assert.ok(pageHtml.includes('name="robots" content="noindex, nofollow"'));

  assert.equal((await get(otherCookie)).status, 404,
    'Another user must see only their own missing subscription');
  assert.equal((await post(otherCookie, false)).status, 404,
    'A tampered active organization must not change the owner subscription');
  assert.equal((await post(ownerCookie, false, 'http://evil.example.test')).status, 403);
  assert.equal(postCount, 0);
  const current = await get(ownerCookie);
  assert.equal(current.status, 200, current.ok ? '' : await current.text());
  assert.equal((await current.json()).data.autoRenewEnabled, true);
  wrongOrder = true;
  assert.equal((await get(ownerCookie)).status, 503, 'Wrong Payment Center order must fail closed');
  wrongOrder = false;
  const disabled = await post(ownerCookie, false);
  assert.equal(disabled.status, 200, disabled.ok ? '' : await disabled.text());
  assert.equal((await disabled.json()).data.autoRenewEnabled, false);
  assert.equal(postCount, 1);
  const duplicate = await post(ownerCookie, false);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).unchanged, true);
  assert.equal(postCount, 1);
  failAfterUpdate = true;
  const recovered = await post(ownerCookie, true);
  assert.equal(recovered.status, 200, recovered.ok ? '' : await recovered.text());
  assert.equal((await recovered.json()).data.autoRenewEnabled, true);
  assert.equal(postCount, 2);
  wrongWriteOrder = true;
  assert.equal((await post(ownerCookie, false)).status, 503,
    'A wrong order in the write response must not be accepted');
  wrongWriteOrder = false;
  assert.equal(postCount, 3);
  console.log('Billing control auth, paid-grant binding, order mismatch, idempotency and uncertain-write recovery passed.');
} finally {
  child?.kill();
  await new Promise<void>((resolveDone) => center?.close(() => resolveDone()) || resolveDone());
  if (organizationId) {
    await sql`DELETE FROM subscription_grants WHERE organization_id = ${organizationId}`;
    await sql`DELETE FROM payment_evidence WHERE organization_id = ${organizationId}`;
    await sql`DELETE FROM subscriptions WHERE organization_id = ${organizationId}`;
    await sql`DELETE FROM payment_intents WHERE organization_id = ${organizationId}`;
    await sql`DELETE FROM billing_accounts WHERE organization_id = ${organizationId}`;
  }
  if (ownerId || otherId) {
    await sql`DELETE FROM organization WHERE id IN
      (SELECT organization_id FROM member WHERE user_id = ${ownerId} OR user_id = ${otherId})`;
    await sql`DELETE FROM "user" WHERE id = ${ownerId} OR id = ${otherId}`;
  }
  await sql.end({ timeout: 5 });
}
