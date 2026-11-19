import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

// This uses Payment Center's dedicated payment_center_test database and mock
// manual approval. It exercises real HTTP, callback signing and both databases.
const paymentRoot = resolve(import.meta.dirname, '../../payment-center');
const python = resolve(paymentRoot, '.venv/Scripts/python.exe');
const secret = randomBytes(32).toString('hex');
const suffix = randomUUID();
const ownerId = `pc-live-owner-${suffix}`;
const organizationId = `pc-live-org-${suffix}`;
const chainOrganizationId = `pc-live-chain-org-${suffix}`;
const commissionOrganizationId = `pc-live-commission-org-${suffix}`;
let webhookPost: ((request: Request) => Promise<Response>) | null = null;
let callbackCount = 0;
let center: ChildProcessWithoutNullStreams | null = null;
let client: (typeof import('../../lib/db/drizzle'))['client'] | null = null;

const callback = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/api/payment-center/webhook' ||
      !webhookPost) {
    response.writeHead(503).end();
    return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const incoming = new Request(`http://127.0.0.1${request.url}`, {
      method: 'POST', headers: request.headers as HeadersInit, body,
    });
    const result = await webhookPost(incoming);
    callbackCount++;
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(500).end();
  }
});

async function waitForCenter(child: ChildProcessWithoutNullStreams) {
  return new Promise<{ port: string; apiKey: string }>((resolveReady, rejectReady) => {
    let output = '';
    const timeout = setTimeout(() => rejectReady(new Error('Payment Center did not start')), 45_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = output.match(/READY\s+(\d+)\s+(\S+)/);
      if (match) {
        clearTimeout(timeout);
        resolveReady({ port: match[1], apiKey: match[2] });
      }
      if (output.length > 32_000) output = output.slice(-8_000);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`Payment Center exited before ready (${code})`));
    });
  });
}

try {
  await new Promise<void>((resolveReady) => callback.listen(0, '127.0.0.1', resolveReady));
  const callbackPort = (callback.address() as AddressInfo).port;
  const callbackBase = `http://127.0.0.1:${callbackPort}`;
  center = spawn(python, ['tests/e2e_payment_center_http_server.py'], {
    cwd: paymentRoot,
    env: {
      ...process.env,
      E2E_CALLBACK_URL: `${callbackBase}/api/payment-center/webhook`,
      E2E_CALLBACK_SECRET: secret,
      E2E_SITE_SIGNING_SECRET: secret,
      E2E_SAAS_CHAIN_PRICE: '1',
      E2E_COMMISSION_PAYER_ID: ownerId,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const { port, apiKey } = await waitForCenter(center);
  const centerBase = `http://127.0.0.1:${port}`;
  const catalogResponse = await fetch(`${centerBase}/api/payment-center/catalog`, {
    headers: { 'X-API-Key': apiKey },
  });
  assert.equal(catalogResponse.status, 200);
  const catalog = (await catalogResponse.json()).data;
  assert.ok(catalog?.website_id && catalog.site_code);
  assert.ok(catalog.methods.includes('manual'));

  process.env.APP_BASE_URL = callbackBase;
  process.env.FEATURE_PAYMENT_CENTER = 'true';
  process.env.FEATURE_COMMISSION_BALANCE = 'true';
  process.env.PAYMENT_CENTER_BASE_URL = centerBase;
  process.env.PAYMENT_CENTER_API_KEY = apiKey;
  process.env.PAYMENT_CENTER_SITE_CODE = catalog.site_code;
  process.env.PAYMENT_CENTER_WEBSITE_ID = catalog.website_id;
  process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = secret;
  webhookPost = (await import('../../app/api/payment-center/webhook/route')).POST;
  const { client: database } = await import('../../lib/db/drizzle');
  client = database;
  const { preparePaymentIntent } = await import('../../lib/billing/intents');
  const { submitPaymentIntent } = await import('../../lib/billing/submit');
  const { runPaymentInbox } = await import('../../lib/payment-center/inbox-worker');

  await database`INSERT INTO "user" (id, name, email)
    VALUES (${ownerId}, 'Payment HTTP Smoke', ${`${ownerId}@example.test`})`;
  await database`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${organizationId}, 'Payment HTTP Smoke', ${`pc-live-${suffix}`}, now())`;
  await database`INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${organizationId}, ${ownerId}, 'owner', now())`;
  const intent = await preparePaymentIntent(organizationId, ownerId, {
    requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
    currency: 'USD', method: 'manual',
  });
  const checkout = await submitPaymentIntent(intent.id, ownerId);
  assert.equal(checkout.status, 'action_required');
  assert.equal(checkout.order.billing_account_id, intent.billingAccountId);

  const submitted = await fetch(`${centerBase}/api/payment-center/orders/${checkout.order.id}/manual-submit`, {
    method: 'POST', headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payer_reference: `SMOKE-${suffix}` }),
  });
  assert.equal(submitted.status, 200);
  const login = await fetch(`${centerBase}/__e2e/admin-login`, { redirect: 'manual' });
  const sessionCookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(sessionCookie);
  const approved = await fetch(`${centerBase}/payment-center/orders/${checkout.order.id}/manual-approve`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ note: 'Local HTTP smoke approval' }),
  });
  assert.equal(approved.status, 302);
  assert.equal(callbackCount, 1, 'The signed merchant callback must reach the SaaS Inbox');

  const report = await runPaymentInbox({ maxJobs: 10 });
  const [inboxState] = await database`SELECT last_error_code FROM payment_inbox
    WHERE external_order_id = ${intent.externalOrderId}`;
  assert.equal(report.processed, 1,
    JSON.stringify({ ...report, lastErrorCode: inboxState?.last_error_code }));
  const [result] = await database`
    SELECT i.status AS intent_status, p.status AS inbox_status,
           e.amount_decimal AS amount, g.status AS grant_status
    FROM payment_intents AS i
    JOIN payment_inbox AS p ON p.external_order_id = i.external_order_id
    JOIN payment_evidence AS e ON e.intent_id = i.id
    JOIN subscription_grants AS g ON g.evidence_id = e.id
    WHERE i.id = ${intent.id}
  `;
  assert.equal(result.intent_status, 'settled');
  assert.equal(result.inbox_status, 'processed');
  assert.equal(result.grant_status, 'active');
  assert.equal(result.amount, '12.50000000');
  assert.equal((await runPaymentInbox({ maxJobs: 10 })).processed, 0);

  await database`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${chainOrganizationId}, 'Chain HTTP Smoke', ${`pc-chain-${suffix}`}, now())`;
  await database`INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${chainOrganizationId}, ${ownerId}, 'owner', now())`;
  const chainIntent = await preparePaymentIntent(chainOrganizationId, ownerId, {
    requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
    currency: 'USDT', method: 'blockchain',
  });
  const chainCheckout = await submitPaymentIntent(chainIntent.id, ownerId);
  assert.equal(chainCheckout.status, 'action_required');
  const chainSettlement = await fetch(
    `${centerBase}/__e2e/settle-chain/${chainCheckout.order.id}`, { method: 'POST' },
  );
  assert.equal(chainSettlement.status, 200, await chainSettlement.text());
  assert.equal(callbackCount, 2);
  const chainReport = await runPaymentInbox({ maxJobs: 10 });
  assert.equal(chainReport.processed, 1, JSON.stringify(chainReport));
  const [chainResult] = await database`
    SELECT i.status AS intent_status, p.status AS inbox_status,
           e.amount_decimal AS amount, g.status AS grant_status
    FROM payment_intents AS i
    JOIN payment_inbox AS p ON p.external_order_id = i.external_order_id
    JOIN payment_evidence AS e ON e.intent_id = i.id
    JOIN subscription_grants AS g ON g.evidence_id = e.id
    WHERE i.id = ${chainIntent.id}
  `;
  assert.equal(chainResult.intent_status, 'settled');
  assert.equal(chainResult.inbox_status, 'processed');
  assert.equal(chainResult.grant_status, 'active');
  assert.ok(Number(chainResult.amount) > 12.5,
    'The actual unique blockchain amount must be retained');
  assert.equal((await runPaymentInbox({ maxJobs: 10 })).processed, 0);

  await database`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${commissionOrganizationId}, 'Commission HTTP Smoke', ${`pc-commission-${suffix}`}, now())`;
  await database`INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${commissionOrganizationId}, ${ownerId}, 'owner', now())`;
  const commissionIntent = await preparePaymentIntent(commissionOrganizationId, ownerId, {
    requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
    currency: 'USDT', method: 'commission_balance',
  });
  const commissionCheckout = await submitPaymentIntent(commissionIntent.id, ownerId);
  assert.equal(commissionCheckout.status, 'action_required');
  assert.equal(commissionCheckout.order.status, 'paid');
  assert.equal(callbackCount, 3);
  const [preparation] = await database`SELECT status, spend_id FROM commission_grant_preparations
    WHERE intent_id = ${commissionIntent.id}`;
  assert.equal(preparation.status, 'confirmed');
  assert.equal(preparation.spend_id, `PC_${commissionCheckout.order.id}`);
  const commissionReport = await runPaymentInbox({ maxJobs: 10 });
  assert.equal(commissionReport.processed, 1, JSON.stringify(commissionReport));
  const [commissionGrant] = await database`SELECT i.status AS intent_status,
      e.amount_decimal AS amount, g.status AS grant_status
    FROM payment_intents AS i
    JOIN payment_evidence AS e ON e.intent_id = i.id
    JOIN subscription_grants AS g ON g.evidence_id = e.id
    WHERE i.id = ${commissionIntent.id}`;
  assert.equal(commissionGrant.intent_status, 'settled');
  assert.equal(commissionGrant.grant_status, 'active');
  assert.equal(commissionGrant.amount, '12.50000000');
  const refund = await fetch(
    `${centerBase}/api/payment-center/orders/${commissionCheckout.order.id}/commission-refund`, {
      method: 'POST', headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'local_e2e_reversal' }),
    });
  assert.equal(refund.status, 200, await refund.text());
  assert.equal(callbackCount, 4);
  const refundReport = await runPaymentInbox({ maxJobs: 10 });
  assert.equal(refundReport.processed, 1, JSON.stringify(refundReport));
  const [reversed] = await database`SELECT e.status AS evidence_status, g.status AS grant_status
    FROM payment_evidence AS e
    JOIN subscription_grants AS g ON g.evidence_id = e.id
    WHERE e.intent_id = ${commissionIntent.id}`;
  assert.equal(reversed.evidence_status, 'reversed');
  assert.equal(reversed.grant_status, 'reversed');
  console.log('Real local Payment Center HTTP, signed manual/chain/commission callbacks, grants and commission refund passed.');
} finally {
  webhookPost = null;
  try {
    if (client) {
      await client`DELETE FROM subscription_grants
        WHERE organization_id IN (${organizationId}, ${chainOrganizationId}, ${commissionOrganizationId})`;
      await client`DELETE FROM payment_evidence
        WHERE organization_id IN (${organizationId}, ${chainOrganizationId}, ${commissionOrganizationId})`;
      await client`DELETE FROM subscriptions
        WHERE organization_id IN (${organizationId}, ${chainOrganizationId}, ${commissionOrganizationId})`;
      await client`DELETE FROM payment_inbox WHERE external_order_id IN
        (SELECT external_order_id FROM payment_intents
          WHERE organization_id IN (${organizationId}, ${chainOrganizationId}, ${commissionOrganizationId}))`;
      await client`DELETE FROM commission_grant_preparations
        WHERE organization_id = ${commissionOrganizationId}`;
      await client`DELETE FROM payment_intents
        WHERE organization_id IN (${organizationId}, ${chainOrganizationId}, ${commissionOrganizationId})`;
      await client`DELETE FROM billing_accounts
        WHERE organization_id IN (${organizationId}, ${chainOrganizationId}, ${commissionOrganizationId})`;
      await client`DELETE FROM organization
        WHERE id IN (${organizationId}, ${chainOrganizationId}, ${commissionOrganizationId})`;
      await client`DELETE FROM "user" WHERE id = ${ownerId}`;
      await client.end({ timeout: 5 });
    }
  } finally {
    center?.kill();
    await new Promise<void>((resolveDone) => callback.close(() => resolveDone()));
  }
}
