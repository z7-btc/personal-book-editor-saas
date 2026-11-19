import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.APP_BASE_URL = 'https://saas.example.test';
process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.FEATURE_COMMISSION_BALANCE = 'true';
process.env.PAYMENT_CENTER_BASE_URL = 'https://payments.example.test';
process.env.PAYMENT_CENTER_API_KEY = 'mock-website-key';
process.env.PAYMENT_CENTER_SITE_CODE = 'saas-test';
process.env.PAYMENT_CENTER_WEBSITE_ID = '00000000-0000-4000-8000-000000000001';
process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = 'mock-callback-secret-longer-than-32-bytes';

const { client } = await import('../../lib/db/drizzle');
const { preparePaymentIntent, PaymentIntentConflict } = await import('../../lib/billing/intents');
const { submitPaymentIntent, reconcileCommissionIntents } = await import('../../lib/billing/submit');
const { BillingAccessError } = await import('../../lib/billing/account');
const suffix = randomUUID();
const ownerId = `submit-owner-${suffix}`;
const memberId = `submit-member-${suffix}`;
const organizationId = `submit-org-${suffix}`;
const remoteOrders = new Map<string, Record<string, unknown>>();
const commissionStates = new Map<string, { spendStatus: 'reserved' | 'completed' | 'cancelled'; eventId: string }>();
let amount = '15.00000000';
let postCalls = 0;
let failAfterCreate = false;
let loseCommissionConfirmResponse = false;
const originalFetch = globalThis.fetch;

const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  assert.equal(new Headers(init?.headers).get('x-api-key'), 'mock-website-key');
  if (url.pathname === '/api/payment-center/catalog') {
    return Response.json({ status: 'success', data: {
      website_id: process.env.PAYMENT_CENTER_WEBSITE_ID,
      site_code: 'saas-test', site_name: 'SaaS Test',
      methods: ['manual', 'commission_balance'], unavailable_methods: {},
      products: [{ code: 'pro', name: 'Pro', description: null, prices: [
        { interval: 'month', amount: Number(amount), amount_decimal: amount, currency: 'USD' },
      ] }],
    } });
  }
  if (url.pathname.startsWith('/api/payment-center/orders/')) {
    const parts = url.pathname.split('/');
    const id = decodeURIComponent(parts[4] || '');
    const order = remoteOrders.get(id);
    const commission = commissionStates.get(id);
    const action = parts[5];
    if (action && order && commission) {
      if (action === 'commission-confirm') {
        assert.equal(init?.method, 'POST');
        commission.spendStatus = 'completed';
        order.status = 'paid';
        order.provider_payment_id = `PC_${order.id}`;
        if (loseCommissionConfirmResponse) {
          loseCommissionConfirmResponse = false;
          throw new TypeError('simulated lost commission confirmation');
        }
      } else if (action === 'commission-cancel') {
        assert.equal(init?.method, 'POST');
        commission.spendStatus = 'cancelled';
        order.status = 'cancelled';
      } else {
        assert.equal(action, 'commission-state');
      }
      return Response.json({ status: 'success', data: {
        order, spend: { external_spend_id: `PC_${order.id}`,
          status: commission.spendStatus, currency: order.currency },
        spend_status: commission.spendStatus,
        ...(action === 'commission-confirm' ? { event_id: commission.eventId } : {}),
      } });
    }
    return order ? Response.json({ status: 'success', data: { order } })
      : new Response(null, { status: 404 });
  }
  assert.equal(url.pathname, '/api/payment-center/orders');
  assert.equal(init?.method, 'POST');
  postCalls++;
  const request = JSON.parse(String(init.body));
  assert.equal(request.external_order_id, request.idempotency_key);
  assert.equal(request.billing_account_id, request.metadata.billingAccountId);
  assert.equal(request.amount, '15.00000000');
  assert.equal(request.catalog_currency, 'USD');
  const existing = remoteOrders.get(request.external_order_id);
  if (existing) {
    assert.equal(existing.idempotency_key, request.idempotency_key);
    if (request.payment_method === 'commission_balance' && existing.status === 'pending') {
      existing.status = 'action_required';
    }
    return Response.json({ status: 'success', data: {
      order: existing, action: existing.payment_details, idempotent: true,
    } });
  }
  const order = {
    id: randomUUID(), website_id: process.env.PAYMENT_CENTER_WEBSITE_ID,
    external_order_id: request.external_order_id,
    idempotency_key: request.idempotency_key,
    payer_external_user_id: request.payer_external_user_id,
    billing_account_id: request.billing_account_id,
    payment_method: request.payment_method, kind: request.kind,
    status: 'action_required', amount_decimal: request.amount,
    currency: request.currency, product_code: request.product_code,
    recurrence_interval: request.recurrence_interval,
    metadata: request.metadata,
    payment_details: request.payment_method === 'commission_balance'
      ? { type: 'commission_reserved', commission_flow: 'two_phase',
        commission_spend_id: '' }
      : { type: 'manual', order_code: 'MANUAL-100' },
  };
  if (request.payment_method === 'commission_balance') {
    assert.equal(request.commission_flow, 'two_phase');
    (order.payment_details as Record<string, unknown>).commission_spend_id = `PC_${order.id}`;
    commissionStates.set(request.external_order_id,
      { spendStatus: 'reserved', eventId: randomUUID() });
  }
  remoteOrders.set(request.external_order_id, order);
  if (failAfterCreate) {
    failAfterCreate = false;
    throw new TypeError('simulated lost response');
  }
  return Response.json({ status: 'success', data: {
    order, action: order.payment_details, idempotent: false, reused: false,
  } }, { status: 201 });
}) as typeof fetch;
globalThis.fetch = send;

try {
  await client`INSERT INTO "user" (id, name, email) VALUES
    (${ownerId}, 'Submit Owner', ${`${ownerId}@example.test`}),
    (${memberId}, 'Submit Member', ${`${memberId}@example.test`})`;
  await client`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${organizationId}, 'Submit Smoke', ${`submit-${suffix}`}, now())`;
  await client`INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${organizationId}, ${ownerId}, 'owner', now()),
           (${randomUUID()}, ${organizationId}, ${memberId}, 'member', now())`;

  const input = {
    requestKey: randomUUID(), productCode: 'pro', priceInterval: 'month',
    currency: 'USD', method: 'manual' as const,
  } satisfies Parameters<typeof preparePaymentIntent>[2];
  const first = await preparePaymentIntent(organizationId, ownerId, input);
  await assert.rejects(submitPaymentIntent(first.id, memberId, send), BillingAccessError);
  const submitted = await submitPaymentIntent(first.id, ownerId, send);
  assert.equal(submitted.status, 'action_required');
  assert.equal(submitted.action.order_code, 'MANUAL-100');
  assert.equal(postCalls, 1);
  const replay = await submitPaymentIntent(first.id, ownerId, send);
  assert.equal(replay.order.id, submitted.order.id);
  assert.equal(postCalls, 1, 'An existing order must never be created twice');

  await client`UPDATE payment_intents SET status = 'cancelled' WHERE id = ${first.id}`;
  remoteOrders.delete(first.externalOrderId);
  const uncertain = await preparePaymentIntent(organizationId, ownerId,
    { ...input, requestKey: randomUUID() });
  failAfterCreate = true;
  await assert.rejects(submitPaymentIntent(uncertain.id, ownerId, send),
    /simulated lost response/);
  const [unknown] = await client`SELECT status, attempt_count FROM payment_intents
    WHERE id = ${uncertain.id}`;
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.attempt_count, 1);
  const recovered = await submitPaymentIntent(uncertain.id, ownerId, send);
  assert.equal(recovered.status, 'action_required');
  assert.equal(postCalls, 2, 'Recovery must query the original external order');
  assert.equal(recovered.order.external_order_id, uncertain.externalOrderId);

  await client`UPDATE payment_intents SET status = 'cancelled' WHERE id = ${uncertain.id}`;
  const commissionIntent = await preparePaymentIntent(organizationId, ownerId,
    { ...input, requestKey: randomUUID(), method: 'commission_balance' });
  const commissionResult = await submitPaymentIntent(commissionIntent.id, ownerId, send);
  assert.equal(commissionResult.order.status, 'paid');
  assert.equal(commissionResult.status, 'action_required', 'Access waits for the signed success event');
  const [prepared] = await client`SELECT status, center_order_id, spend_id
    FROM commission_grant_preparations WHERE intent_id = ${commissionIntent.id}`;
  assert.equal(prepared.status, 'confirmed');
  assert.equal(prepared.center_order_id, commissionResult.order.id);
  assert.equal(prepared.spend_id, `PC_${commissionResult.order.id}`);
  const replayCommission = await submitPaymentIntent(commissionIntent.id, ownerId, send);
  assert.equal(replayCommission.order.id, commissionResult.order.id);
  assert.equal(commissionStates.get(commissionIntent.externalOrderId)?.spendStatus, 'completed');
  await client`UPDATE payment_intents SET status = 'cancelled' WHERE id = ${commissionIntent.id}`;
  const uncertainCommission = await preparePaymentIntent(organizationId, ownerId,
    { ...input, requestKey: randomUUID(), method: 'commission_balance' });
  loseCommissionConfirmResponse = true;
  await assert.rejects(submitPaymentIntent(uncertainCommission.id, ownerId, send),
    /simulated lost commission confirmation/);
  const [pendingPreparation] = await client`SELECT status FROM commission_grant_preparations
    WHERE intent_id = ${uncertainCommission.id}`;
  assert.equal(pendingPreparation.status, 'prepared');
  const recovery = await reconcileCommissionIntents(10, send);
  assert.ok(recovery.recovered >= 1, JSON.stringify(recovery));
  const [recoveredPreparation] = await client`SELECT status FROM commission_grant_preparations
    WHERE intent_id = ${uncertainCommission.id}`;
  assert.equal(recoveredPreparation.status, 'confirmed');
  await client`UPDATE payment_intents SET status = 'cancelled' WHERE id = ${uncertainCommission.id}`;
  const partialCommission = await preparePaymentIntent(organizationId, ownerId,
    { ...input, requestKey: randomUUID(), method: 'commission_balance' });
  const partialOrderId = randomUUID();
  remoteOrders.set(partialCommission.externalOrderId, {
    ...commissionResult.order,
    id: partialOrderId,
    external_order_id: partialCommission.externalOrderId,
    idempotency_key: partialCommission.idempotencyKey,
    status: 'pending', provider_payment_id: null,
    metadata: { organizationId, billingAccountId: partialCommission.billingAccountId,
      payerUserId: ownerId, intentId: partialCommission.id },
    payment_details: { commission_flow: 'two_phase',
      commission_spend_id: `PC_${partialOrderId}` },
  });
  commissionStates.set(partialCommission.externalOrderId,
    { spendStatus: 'reserved', eventId: randomUUID() });
  const recoveredPartial = await submitPaymentIntent(partialCommission.id, ownerId, send);
  assert.equal(recoveredPartial.order.id, partialOrderId);
  assert.equal(recoveredPartial.order.status, 'paid');
  await client`UPDATE payment_intents SET status = 'cancelled' WHERE id = ${partialCommission.id}`;
  const stale = await preparePaymentIntent(organizationId, ownerId,
    { ...input, requestKey: randomUUID() });
  amount = '17.00000000';
  await assert.rejects(submitPaymentIntent(stale.id, ownerId, send), PaymentIntentConflict);
  const [rejected] = await client`SELECT status, last_error_code FROM payment_intents
    WHERE id = ${stale.id}`;
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.last_error_code, 'quote_changed');
  assert.equal(postCalls, 5, 'A changed quote must not create a remote order');

  const blocked = await preparePaymentIntent(organizationId, ownerId,
    { ...input, requestKey: randomUUID() });
  const failedPreparation = await preparePaymentIntent(organizationId, ownerId,
    { ...input, requestKey: randomUUID(), method: 'commission_balance' });
  const failedOrderId = randomUUID();
  remoteOrders.set(failedPreparation.externalOrderId, {
    ...commissionResult.order, id: failedOrderId,
    external_order_id: failedPreparation.externalOrderId,
    idempotency_key: failedPreparation.idempotencyKey,
    status: 'action_required', provider_payment_id: null,
    amount_decimal: failedPreparation.amountDecimal,
    metadata: { organizationId, billingAccountId: failedPreparation.billingAccountId,
      payerUserId: ownerId, intentId: failedPreparation.id },
    payment_details: { commission_flow: 'two_phase',
      commission_spend_id: `PC_${failedOrderId}` },
  });
  commissionStates.set(failedPreparation.externalOrderId,
    { spendStatus: 'reserved', eventId: randomUUID() });
  await client`UPDATE payment_intents SET status = 'action_required',
    payment_center_order_id = ${failedOrderId} WHERE id = ${failedPreparation.id}`;
  const evidenceId = `pe_${randomUUID().replaceAll('-', '')}`;
  await client`INSERT INTO payment_evidence
    (id, website_id, organization_id, intent_id, evidence_key, source_event_id,
     center_order_id, amount_decimal, currency, settled_at, service_period_start,
     service_period_end)
    VALUES (${evidenceId}, ${process.env.PAYMENT_CENTER_WEBSITE_ID!},
      ${organizationId}, ${first.id}, ${`order:${randomUUID()}`}, ${randomUUID()},
      ${randomUUID()}, '15.00000000', 'USD', now(), now(), now() + interval '1 month')`;
  await client`INSERT INTO subscription_grants
    (id, organization_id, evidence_id, product_code, payment_method, period_start,
     period_end) VALUES (${`sg_${randomUUID().replaceAll('-', '')}`},
      ${organizationId}, ${evidenceId}, 'pro', 'manual', now(),
      now() + interval '1 month')`;
  await assert.rejects(submitPaymentIntent(failedPreparation.id, ownerId, send),
    PaymentIntentConflict);
  assert.equal(commissionStates.get(failedPreparation.externalOrderId)?.spendStatus,
    'cancelled', 'A local grant conflict must release the remote reservation');
  const [failedIntent] = await client`SELECT status FROM payment_intents
    WHERE id = ${failedPreparation.id}`;
  assert.equal(failedIntent.status, 'failed');
  await assert.rejects(preparePaymentIntent(organizationId, ownerId,
    { ...input, requestKey: randomUUID() }),
  PaymentIntentConflict);
  await assert.rejects(submitPaymentIntent(blocked.id, ownerId, send),
    PaymentIntentConflict);
  assert.equal(postCalls, 5, 'A paid workspace must not create another order');
  console.log('Payment submission, commission preparation/cancel, partial-order and lost-response recovery passed.');
} finally {
  globalThis.fetch = originalFetch;
  await client`DELETE FROM subscription_grants WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM payment_evidence WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM commission_grant_preparations WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM payment_intents WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM billing_accounts WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM organization WHERE id = ${organizationId}`;
  await client`DELETE FROM "user" WHERE id IN (${ownerId}, ${memberId})`;
  await client.end({ timeout: 5 });
}
