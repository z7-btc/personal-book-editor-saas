import { sql } from 'drizzle-orm';
import { bigserial, check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth-schema';

// No free-form metadata, email, IP, session token, wallet, or request body.
// Internal entity references stay server-side and never enter the feed DTO.
export const accountActivity = pgTable('account_activity', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
  eventType: text('event_type', { enum: [
    'account_created', 'account_profile_updated', 'account_email_changed',
    'security_email_verified', 'security_email_unverified', 'security_password_changed', 'security_session_created',
    'billing_checkout_created', 'billing_payment_confirmed', 'billing_payment_reversed', 'billing_payment_restored',
    'billing_access_granted', 'billing_access_revoked', 'billing_access_restored',
  ] }).notNull(),
  source: text('source', { enum: ['database', 'auth', 'system'] }).notNull(),
  operationKey: text('operation_key').notNull(),
  entityType: text('entity_type', { enum: ['user', 'session', 'account', 'payment_intent', 'payment_evidence', 'subscription_grant'] }),
  entityId: text('entity_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (table) => [
  uniqueIndex('account_activity_user_operation_unique').on(table.userId, table.operationKey),
  index('account_activity_user_cursor_idx').on(table.userId, table.id),
  check('account_activity_event_check', sql`${table.eventType} IN (
    'account_created', 'account_profile_updated', 'account_email_changed',
    'security_email_verified', 'security_email_unverified', 'security_password_changed', 'security_session_created',
    'billing_checkout_created', 'billing_payment_confirmed', 'billing_payment_reversed', 'billing_payment_restored',
    'billing_access_granted', 'billing_access_revoked', 'billing_access_restored')`),
  check('account_activity_source_check', sql`${table.source} IN ('database', 'auth', 'system')`),
  check('account_activity_operation_check', sql`char_length(${table.operationKey}) BETWEEN 1 AND 240`),
  check('account_activity_entity_check', sql`(${table.entityType} IS NULL AND ${table.entityId} IS NULL)
    OR (${table.entityType} IS NOT NULL AND ${table.entityId} IS NOT NULL
      AND ${table.entityType} IN ('user', 'session', 'account', 'payment_intent', 'payment_evidence', 'subscription_grant')
      AND char_length(${table.entityId}) BETWEEN 1 AND 160)`),
]);
