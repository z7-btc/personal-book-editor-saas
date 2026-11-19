import { relations, sql } from 'drizzle-orm';
import { bigserial, check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { organization, user } from './auth-schema';

export const emailOutboxStatus = pgEnum('email_outbox_status', [
  'pending', 'processing', 'succeeded', 'dead_letter', 'superseded',
]);

// No email address or request body is stored here. The worker reads the
// current user record when it sends, so a superseded event cannot expose old
// contact details through a stale payload.
export const emailContactOutbox = pgTable('email_contact_outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  eventVersion: integer('event_version').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  status: emailOutboxStatus('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
  reconcileAfter: timestamp('reconcile_after', { withTimezone: true }).defaultNow(),
  lastReconcileCode: text('last_reconcile_code'),
  reconcileLeaseOwner: text('reconcile_lease_owner'),
  reconcileLeaseExpiresAt: timestamp('reconcile_lease_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('email_contact_outbox_user_version_unique').on(table.userId, table.eventVersion),
  uniqueIndex('email_contact_outbox_one_active_per_user').on(table.userId)
    .where(sql`${table.status} = 'processing' OR ${table.reconcileLeaseOwner} IS NOT NULL`),
  index('email_contact_outbox_claim_idx').on(table.status, table.availableAt),
  index('email_contact_outbox_user_idx').on(table.userId, table.id),
  index('email_contact_outbox_reconcile_idx').on(table.reconcileAfter),
]);

export const emailContactOutboxRelations = relations(emailContactOutbox, ({ one }) => ({
  user: one(user, { fields: [emailContactOutbox.userId], references: [user.id] }),
}));

export const referralSyncStatus = pgEnum('referral_sync_status', [
  'pending', 'processing', 'succeeded', 'dead_letter', 'superseded',
]);

// Created in the same database transaction as the auth user. The invite code
// remains stable even when the external referral service is unavailable.
export const referralProfiles = pgTable('referral_profiles', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  inviteCode: text('invite_code').notNull(),
  syncVersion: integer('sync_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('referral_profiles_invite_code_unique').on(table.inviteCode),
  check('referral_profiles_sync_version_check', sql`${table.syncVersion} > 0`),
]);

// Local mirror of the first verified invitation. Commission amounts and
// balances never live in this table; Payment Center remains authoritative.
export const referralAttributions = pgTable('referral_attributions', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  inviterUserId: text('inviter_user_id').notNull(),
  inviteCode: text('invite_code').notNull(),
  boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('referral_attributions_inviter_idx').on(table.inviterUserId, table.boundAt),
  check('referral_attributions_not_self_check', sql`${table.userId} <> ${table.inviterUserId}`),
]);

// No email or external request body is retained. The worker reads the current
// user and the immutable attribution when it sends the newest version.
export const referralUserOutbox = pgTable('referral_user_outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  eventVersion: integer('event_version').notNull(),
  status: referralSyncStatus('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('referral_user_outbox_user_version_unique').on(table.userId, table.eventVersion),
  uniqueIndex('referral_user_outbox_one_processing_per_user').on(table.userId)
    .where(sql`${table.status} = 'processing'`),
  index('referral_user_outbox_claim_idx').on(table.status, table.availableAt),
]);

export const referralWithdrawalStatus = pgEnum('referral_withdrawal_status', [
  'pending', 'sending', 'submitted', 'uncertain', 'rejected', 'manual_review',
]);

// This row is both the immutable request intent and its recoverable send job.
// The payout account is encrypted with authenticated associated data; only a
// mask and keyed fingerprint are available to ordinary database inspection.
// `accountCiphertext` becomes null once the retention scrub has removed the
// payload of a terminal payout, which is why it is the only nullable column
// here: the request itself, its amount and its provider id are facts and stay.
export const referralWithdrawalIntents = pgTable('referral_withdrawal_intents', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  requestKey: text('request_key').notNull(),
  amountDecimal: text('amount_decimal').notNull(),
  currency: text('currency').notNull().default('USDT'),
  method: text('method').notNull(),
  blockchain: text('blockchain'),
  accountCiphertext: text('account_ciphertext'),
  accountKeyVersion: text('account_key_version').notNull(),
  accountFingerprint: text('account_fingerprint').notNull(),
  accountMask: text('account_mask').notNull(),
  status: referralWithdrawalStatus('status').notNull().default('pending'),
  centerWithdrawalId: text('center_withdrawal_id'),
  attemptCount: integer('attempt_count').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('referral_withdrawal_user_request_unique').on(table.userId, table.requestKey),
  uniqueIndex('referral_withdrawal_center_unique').on(table.centerWithdrawalId),
  index('referral_withdrawal_queue_idx').on(table.status, table.availableAt),
  index('referral_withdrawal_user_idx').on(table.userId, table.createdAt),
  check('referral_withdrawal_amount_check',
    sql`${table.amountDecimal} ~ '^(0|[1-9][0-9]*)([.][0-9]{1,8})?$' AND ${table.amountDecimal}::numeric > 0`),
  check('referral_withdrawal_currency_check', sql`${table.currency} = 'USDT'`),
  check('referral_withdrawal_method_check', sql`${table.method} IN ('BINANCE_UID', 'BLOCKCHAIN')`),
  check('referral_withdrawal_chain_check',
    sql`(${table.method} = 'BINANCE_UID' AND ${table.blockchain} IS NULL) OR
        (${table.method} = 'BLOCKCHAIN' AND ${table.blockchain} IN ('BSC', 'ARBITRUM'))`),
  check('referral_withdrawal_fingerprint_check', sql`${table.accountFingerprint} ~ '^[0-9a-f]{64}$'`),
]);

export const paymentIntentStatus = pgEnum('payment_intent_status', [
  'pending', 'submitting', 'action_required', 'unknown', 'failed',
  'cancelled', 'settled', 'manual_review',
]);

// A workspace has one stable external billing identity. Historical payer IDs
// are retained even after a person leaves the workspace.
export const billingAccounts = pgTable('billing_accounts', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organization.id, { onDelete: 'restrict' }),
  externalBillingId: text('external_billing_id').notNull(),
  originalPayerUserId: text('original_payer_user_id').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('billing_accounts_organization_unique').on(table.organizationId),
  uniqueIndex('billing_accounts_external_unique').on(table.externalBillingId),
]);

// No browser amount or provider proof is stored. This captures the immutable
// server-side quote and the exact external idempotency boundary before a call.
export const paymentIntents = pgTable('payment_intents', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organization.id, { onDelete: 'restrict' }),
  billingAccountId: text('billing_account_id').notNull()
    .references(() => billingAccounts.id, { onDelete: 'restrict' }),
  payerUserId: text('payer_user_id').notNull(),
  requestKey: text('request_key').notNull(),
  productCode: text('product_code').notNull(),
  priceInterval: text('price_interval').notNull(),
  amountDecimal: text('amount_decimal').notNull(),
  currency: text('currency').notNull(),
  // The method name is copied from the Payment Center catalogue and is not an
  // enum on purpose: enabling a new channel there must never require a
  // database migration here. `paymentAction` and `settlementCurrency` capture
  // what this column cannot — the capability shape the order follows and the
  // asset it actually settles in.
  method: text('method').notNull(),
  paymentAction: text('payment_action').notNull(),
  settlementCurrency: text('settlement_currency'),
  status: paymentIntentStatus('status').notNull().default('pending'),
  externalOrderId: text('external_order_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  paymentCenterOrderId: text('payment_center_order_id'),
  // Naive on purpose, and UTC on purpose: the application writes and compares it
  // through JS `Date`s, which Drizzle maps to a UTC wall clock in both directions.
  // Raw SQL must therefore say `(now() AT TIME ZONE 'UTC')` — a bare `now()` would
  // be read back as Asia/Shanghai and give the lease eight extra hours.
  submissionLeaseExpiresAt: timestamp('submission_lease_expires_at'),
  attemptCount: integer('attempt_count').notNull().default(0),
  lastErrorCode: text('last_error_code'),
  // Settled at checkout time when a buyer switches plans mid-subscription: the
  // remaining paid time is prorated by the old/new monthly price, and this is
  // the resulting period end. The fulfilment honours it instead of the centre's
  // payment-moment span. Null for a fresh purchase or a same-plan renewal.
  proratedPeriodEnd: timestamp('prorated_period_end'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('payment_intents_request_unique').on(table.organizationId, table.payerUserId, table.requestKey),
  uniqueIndex('payment_intents_external_order_unique').on(table.externalOrderId),
  uniqueIndex('payment_intents_idempotency_unique').on(table.idempotencyKey),
  uniqueIndex('payment_intents_center_order_unique').on(table.paymentCenterOrderId),
  // One open order per channel, not per workspace: a buyer who opened a card
  // checkout and changed their mind must still be able to pay by crypto or
  // commission balance. The application applies the same rule when it looks for
  // an open intent to resume; this index is what makes two concurrent requests
  // agree on it.
  uniqueIndex('payment_intents_one_open_checkout_per_channel')
    .on(table.organizationId, table.method)
    .where(sql`${table.status} IN ('submitting', 'action_required', 'unknown')`),
  index('payment_intents_workspace_status_idx').on(table.organizationId, table.status),
  check('payment_intents_amount_decimal_check',
    sql`${table.amountDecimal} ~ '^(0|[1-9][0-9]*)([.][0-9]{1,8})?$' AND ${table.amountDecimal}::numeric > 0`),
  check('payment_intents_currency_check', sql`${table.currency} ~ '^[A-Z]{3,10}$'`),
  check('payment_intents_request_key_check', sql`char_length(${table.requestKey}) BETWEEN 1 AND 100`),
  check('payment_intents_order_key_check',
    sql`char_length(${table.externalOrderId}) BETWEEN 1 AND 180 AND char_length(${table.idempotencyKey}) BETWEEN 1 AND 180`),
]);

// A durable promise that the workspace can accept this reserved commission
// order. It grants no access until Payment Center confirms the spend and its
// signed payment event is verified by the inbox worker.
export const commissionGrantPreparations = pgTable('commission_grant_preparations', {
  intentId: text('intent_id').primaryKey()
    .references(() => paymentIntents.id, { onDelete: 'restrict' }),
  organizationId: text('organization_id').notNull()
    .references(() => organization.id, { onDelete: 'restrict' }),
  centerOrderId: text('center_order_id').notNull(),
  spendId: text('spend_id').notNull(),
  status: text('status').notNull().default('prepared'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('commission_grant_preparations_order_unique').on(table.centerOrderId),
  uniqueIndex('commission_grant_preparations_spend_unique').on(table.spendId),
  index('commission_grant_preparations_workspace_idx').on(table.organizationId, table.status),
  check('commission_grant_preparations_status_check',
    sql`${table.status} IN ('prepared', 'confirmed', 'cancelled')`),
]);

export const paymentInboxStatus = pgEnum('payment_inbox_status', [
  'pending', 'processing', 'quarantined', 'manual_review', 'processed',
]);

// Only routing identifiers and a body digest are retained. The signed callback
// is acknowledged after a durable insert, then verified against Payment Center
// again before any billing command can run.
export const paymentInbox = pgTable('payment_inbox', {
  eventId: text('event_id').primaryKey(),
  eventType: text('event_type').notNull(),
  centerOrderId: text('center_order_id').notNull(),
  externalOrderId: text('external_order_id').notNull(),
  websiteId: text('website_id').notNull(),
  bodySha256: text('body_sha256').notNull(),
  status: paymentInboxStatus('status').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  receivedAt: timestamp('received_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('payment_inbox_status_received_idx').on(table.status, table.receivedAt),
  index('payment_inbox_external_order_idx').on(table.externalOrderId),
  check('payment_inbox_body_hash_check', sql`${table.bodySha256} ~ '^[0-9a-f]{64}$'`),
]);

// Signed Payment Center health challenges are one-use across web instances.
// The challenge ID is the only retained request field; expired rows are pruned
// on the next authorized check.
export const paymentHandshakeChallenges = pgTable('payment_handshake_challenges', {
  checkId: text('check_id').primaryKey(),
  siteCode: text('site_code').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('payment_handshake_challenges_expires_idx').on(table.expiresAt),
  check('payment_handshake_challenges_id_check', sql`${table.checkId} ~ '^[0-9a-f]{32}$'`),
]);

export const paymentEvidenceStatus = pgEnum('payment_evidence_status', [
  'settled', 'reversed',
]);

// Minimal verified facts. Provider receipts and payment instruments stay in
// Payment Center; one stable business key represents one paid period.
export const paymentEvidence = pgTable('payment_evidence', {
  id: text('id').primaryKey(),
  websiteId: text('website_id').notNull(),
  organizationId: text('organization_id').notNull()
    .references(() => organization.id, { onDelete: 'restrict' }),
  intentId: text('intent_id').notNull()
    .references(() => paymentIntents.id, { onDelete: 'restrict' }),
  evidenceKey: text('evidence_key').notNull(),
  sourceEventId: text('source_event_id').notNull(),
  centerOrderId: text('center_order_id').notNull(),
  providerSubscriptionId: text('provider_subscription_id'),
  providerInvoiceId: text('provider_invoice_id'),
  providerPaymentId: text('provider_payment_id'),
  amountDecimal: text('amount_decimal').notNull(),
  currency: text('currency').notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }).notNull(),
  servicePeriodStart: timestamp('service_period_start', { withTimezone: true }).notNull(),
  servicePeriodEnd: timestamp('service_period_end', { withTimezone: true }).notNull(),
  status: paymentEvidenceStatus('status').notNull().default('settled'),
  reversedByEventId: text('reversed_by_event_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('payment_evidence_website_key_unique').on(table.websiteId, table.evidenceKey),
  index('payment_evidence_workspace_idx').on(table.organizationId, table.servicePeriodEnd),
  check('payment_evidence_amount_check',
    sql`${table.amountDecimal} ~ '^(0|[1-9][0-9]*)([.][0-9]{1,8})?$' AND ${table.amountDecimal}::numeric > 0`),
  check('payment_evidence_period_check',
    sql`${table.servicePeriodEnd} > ${table.servicePeriodStart}`),
]);

export const subscriptionGrantStatus = pgEnum('subscription_grant_status', [
  'active', 'reversed',
]);

export const subscriptionGrants = pgTable('subscription_grants', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull()
    .references(() => organization.id, { onDelete: 'restrict' }),
  evidenceId: text('evidence_id').notNull()
    .references(() => paymentEvidence.id, { onDelete: 'restrict' }),
  productCode: text('product_code').notNull(),
  paymentMethod: text('payment_method').notNull(),
  providerSubscriptionId: text('provider_subscription_id'),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  status: subscriptionGrantStatus('status').notNull().default('active'),
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('subscription_grants_evidence_unique').on(table.evidenceId),
  index('subscription_grants_workspace_period_idx').on(table.organizationId, table.periodEnd),
  check('subscription_grants_period_check', sql`${table.periodEnd} > ${table.periodStart}`),
]);

export const subscriptions = pgTable('subscriptions', {
  organizationId: text('organization_id').primaryKey()
    .references(() => organization.id, { onDelete: 'restrict' }),
  productCode: text('product_code'),
  paymentMethod: text('payment_method'),
  providerSubscriptionId: text('provider_subscription_id'),
  status: text('status').notNull().default('inactive'),
  activeUntil: timestamp('active_until', { withTimezone: true }),
  version: integer('version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('subscriptions_status_check', sql`${table.status} IN ('active', 'inactive')`),
]);
