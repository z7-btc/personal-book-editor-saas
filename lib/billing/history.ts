import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import { getCapabilities } from '@/lib/config';
import { personalSlug } from '@/lib/workspace/bootstrap';
import { BillingAccessError } from './account';
import { billingHistorySchema, type BillingHistory, type BillingHistorySection } from './history-contract';

export class BillingHistoryCursorError extends Error {}

const cursorSchema = z.object({
  section: z.enum(['orders', 'payments']), id: z.string().min(1).max(180),
}).strict();

function parseCursor(value: string | undefined, section: BillingHistorySection) {
  if (!value) return null;
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error();
    const parsed = cursorSchema.parse(JSON.parse(decoded.toString('utf8')));
    if (parsed.section !== section) throw new Error();
    return parsed.id;
  } catch { throw new BillingHistoryCursorError('Invalid billing cursor'); }
}

function nextCursor(section: 'orders' | 'payments', id: string) {
  return Buffer.from(JSON.stringify({ section, id })).toString('base64url');
}

// No remote request, account creation, or aggregate mutation occurs in this read.
// All rows and cursor anchors are scoped inside the same read-only snapshot.
export async function getBillingHistory(actorUserId: string, options: {
  section?: BillingHistorySection; cursor?: string; limit?: number; now?: Date;
} = {}): Promise<BillingHistory> {
  const section = options.section ?? 'all';
  const limit = options.limit ?? 10;
  if (!['all', 'orders', 'payments'].includes(section) || !Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new BillingHistoryCursorError('Invalid billing page');
  }
  const anchorId = parseCursor(options.cursor, section);
  const now = options.now ?? new Date();
  const empty: BillingHistory = {
    asOf: now.toISOString(), paymentEnabled: getCapabilities().paymentCenter.configured,
    subscription: { state: 'none', productCode: null, method: null, periodStart: null, periodEnd: null },
    orders: { items: [], nextCursor: null }, payments: { items: [], nextCursor: null },
  };
  return db.transaction(async (tx) => {
    const [workspace] = await tx.execute<{ id: string; role: string }>(sql`
      SELECT o.id, m.role FROM organization o INNER JOIN member m ON m.organization_id = o.id
      WHERE o.slug = ${personalSlug(actorUserId)} AND m.user_id = ${actorUserId} LIMIT 1`);
    if (!workspace) {
      if (anchorId) throw new BillingHistoryCursorError('Billing cursor no longer exists');
      return empty;
    }
    if (workspace.role !== 'owner') throw new BillingAccessError('Personal billing requires its owner');
    const [account] = await tx.execute<{ id: string; payer: string }>(sql`
      SELECT id, original_payer_user_id AS payer FROM billing_accounts
      WHERE organization_id = ${workspace.id} LIMIT 1`);
    if (!account) {
      if (anchorId) throw new BillingHistoryCursorError('Billing cursor no longer exists');
      return empty;
    }
    if (account.payer !== actorUserId) throw new BillingAccessError('Personal billing belongs to another user');
    const websiteId = process.env.PAYMENT_CENTER_WEBSITE_ID?.trim();
    const owned = sql`owned_intents AS (
      SELECT i.* FROM payment_intents i INNER JOIN billing_accounts b ON b.id = i.billing_account_id
      WHERE i.organization_id = ${workspace.id} AND b.organization_id = i.organization_id
        AND i.billing_account_id = ${account.id} AND i.payer_user_id = ${actorUserId}
        AND b.original_payer_user_id = ${actorUserId}
    ), verified_evidence AS (
      SELECT e.*, i.product_code, i.method, i.price_interval, i.external_order_id
      FROM payment_evidence e INNER JOIN owned_intents i ON i.id = e.intent_id
      WHERE e.organization_id = i.organization_id AND e.center_order_id = i.payment_center_order_id
        -- A channel may settle in an asset the buyer picked, which can differ
        -- from the catalogue currency (a USD quote paid in USDT one to one).
        -- New orders record that asset on the intent; rows from before this
        -- column existed keep their historical per-channel allowances.
        AND (e.currency = COALESCE(i.settlement_currency, i.currency)
          OR (i.settlement_currency IS NULL
            AND ((i.method = 'blockchain' AND e.currency IN ('USDT', 'USDC', 'BUSD', 'DAI'))
              OR (i.method = 'binance_pay' AND e.currency IN ('USDT', 'USDC')))))
        ${websiteId ? sql`AND e.website_id = ${websiteId}` : sql``}
    ), verified_grants AS (
      SELECT g.* FROM subscription_grants g INNER JOIN verified_evidence e ON e.id = g.evidence_id
      WHERE g.organization_id = e.organization_id AND g.product_code = e.product_code
        AND g.payment_method = e.method AND g.provider_subscription_id IS NOT DISTINCT FROM e.provider_subscription_id
        AND (e.method <> 'stripe' OR e.provider_subscription_id IS NOT NULL)
        AND g.period_start = e.service_period_start AND g.period_end = e.service_period_end
    )`;
    const [active] = await tx.execute<{
      productCode: string; method: BillingHistory['subscription']['method']; periodStart: string; periodEnd: string;
    }>(sql`WITH ${owned} SELECT g.product_code AS "productCode", g.payment_method AS method,
      g.period_start::text AS "periodStart", g.period_end::text AS "periodEnd"
      FROM verified_grants g INNER JOIN verified_evidence e ON e.id = g.evidence_id
      WHERE g.status = 'active' AND e.status = 'settled'
        AND g.period_start <= ${now.toISOString()}::timestamptz AND g.period_end > ${now.toISOString()}::timestamptz
      ORDER BY g.period_end DESC, g.id DESC LIMIT 1`);
    if (active) empty.subscription = {
      state: 'active', productCode: active.productCode, method: active.method,
      periodStart: new Date(active.periodStart).toISOString(), periodEnd: new Date(active.periodEnd).toISOString(),
    };
    if (section === 'all' || section === 'orders') {
      if (anchorId) {
        const found = await tx.execute(sql`WITH ${owned} SELECT id FROM owned_intents WHERE id = ${anchorId}`);
        if (!found.length) throw new BillingHistoryCursorError('Billing cursor no longer exists');
      }
      const rows = await tx.execute<{
        id: string; productCode: string; interval: 'month' | 'year'; method: BillingHistory['orders']['items'][number]['method'];
        status: BillingHistory['orders']['items'][number]['status']; amountDecimal: string; currency: string;
        recordedAt: string; hasVerifiedPayment: boolean;
      }>(sql`WITH ${owned} SELECT i.id, i.product_code AS "productCode", i.price_interval AS interval,
        i.method, i.amount_decimal AS "amountDecimal", i.currency,
        (i.created_at AT TIME ZONE current_setting('TimeZone'))::text AS "recordedAt",
        EXISTS (SELECT 1 FROM verified_evidence e WHERE e.intent_id = i.id) AS "hasVerifiedPayment",
        CASE WHEN i.status = 'settled' AND NOT EXISTS (
          SELECT 1 FROM verified_evidence e WHERE e.intent_id = i.id
        ) THEN 'awaiting_confirmation' ELSE i.status::text END AS status
        FROM owned_intents i ${anchorId ? sql`WHERE (i.created_at, i.id) < (
          SELECT created_at, id FROM owned_intents WHERE id = ${anchorId})` : sql``}
        ORDER BY i.created_at DESC, i.id DESC LIMIT ${limit + 1}`);
      const visible = rows.slice(0, limit);
      empty.orders = {
        items: visible.map((row) => ({ ...row, recordedAt: new Date(row.recordedAt).toISOString() })),
        nextCursor: rows.length > limit ? nextCursor('orders', visible.at(-1)!.id) : null,
      };
    }
    if (section === 'all' || section === 'payments') {
      if (anchorId) {
        const found = await tx.execute(sql`WITH ${owned} SELECT id FROM verified_evidence WHERE id = ${anchorId}`);
        if (!found.length) throw new BillingHistoryCursorError('Billing cursor no longer exists');
      }
      const rows = await tx.execute<{
        id: string; orderId: string; productCode: string; method: BillingHistory['payments']['items'][number]['method'];
        amountDecimal: string; currency: string; settledAt: string; periodStart: string; periodEnd: string;
        status: BillingHistory['payments']['items'][number]['status']; access: BillingHistory['payments']['items'][number]['access'];
      }>(sql`WITH ${owned} SELECT e.id, e.intent_id AS "orderId", e.product_code AS "productCode", e.method,
        e.amount_decimal AS "amountDecimal", e.currency, e.settled_at::text AS "settledAt",
        e.service_period_start::text AS "periodStart", e.service_period_end::text AS "periodEnd",
        CASE WHEN e.status = 'settled' THEN 'settled'
          WHEN r.event_type IN ('payment.refunded', 'subscription.period_refunded') THEN 'refunded'
          WHEN r.event_type = 'subscription.period_disputed' THEN 'disputed' ELSE 'reversed' END AS status,
        CASE WHEN e.status = 'reversed' OR g.status = 'reversed' THEN 'revoked'
          WHEN g.id IS NULL THEN 'review'
          WHEN g.period_start > ${now.toISOString()}::timestamptz THEN 'upcoming'
          WHEN g.period_end <= ${now.toISOString()}::timestamptz THEN 'expired' ELSE 'active' END AS access
        FROM verified_evidence e LEFT JOIN verified_grants g ON g.evidence_id = e.id
        LEFT JOIN payment_inbox r ON r.event_id = e.reversed_by_event_id AND r.status = 'processed'
          AND r.website_id = e.website_id AND r.center_order_id = e.center_order_id
          AND r.external_order_id = e.external_order_id
        ${anchorId ? sql`WHERE (e.settled_at, e.id) < (
          SELECT settled_at, id FROM verified_evidence WHERE id = ${anchorId})` : sql``}
        ORDER BY e.settled_at DESC, e.id DESC LIMIT ${limit + 1}`);
      const visible = rows.slice(0, limit);
      empty.payments = {
        items: visible.map((row) => ({ ...row, settledAt: new Date(row.settledAt).toISOString(),
          periodStart: new Date(row.periodStart).toISOString(), periodEnd: new Date(row.periodEnd).toISOString() })),
        nextCursor: rows.length > limit ? nextCursor('payments', visible.at(-1)!.id) : null,
      };
    }
    return billingHistorySchema.parse(empty);
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
