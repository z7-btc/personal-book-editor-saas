import 'server-only';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import { accountActivity } from '@/lib/db/activity-schema';
import { logObservation } from '@/lib/observability/logger';
import { activityEventTypes } from './events';

const inputSchema = z.object({
  userId: z.string().min(1).max(160), type: z.enum(activityEventTypes),
  source: z.enum(['auth', 'system']), operationKey: z.string().min(1).max(240),
  entityType: z.enum(['user', 'session', 'account', 'payment_intent', 'payment_evidence', 'subscription_grant']).optional(),
  entityId: z.string().min(1).max(160).optional(), occurredAt: z.date().optional(),
}).strict().refine((value) => Boolean(value.entityType) === Boolean(value.entityId));
export type RecordActivityInput = z.infer<typeof inputSchema>;

// Internal callers own canonical identity and operation keys. This helper is
// never exposed as a browser write API; pass an existing business transaction
// when a hook must commit with that fact rather than issue a separate write.
export async function recordActivity(input: RecordActivityInput, connection: Pick<typeof db, 'insert' | 'select'> = db) {
  const value = inputSchema.parse(input);
  const [created] = await connection.insert(accountActivity).values({
    userId: value.userId, eventType: value.type, source: value.source,
    operationKey: value.operationKey, entityType: value.entityType ?? null,
    entityId: value.entityId ?? null, ...(value.occurredAt ? { occurredAt: value.occurredAt } : {}),
  }).onConflictDoNothing({ target: [accountActivity.userId, accountActivity.operationKey] })
    .returning({ id: accountActivity.id });
  // A repeated business operation resolves to the row the first attempt wrote.
  // Returning `null` here forced every retrying caller to guess, and the audit
  // trail is only useful if a replayed hook can still name the stored fact.
  let id = created?.id ?? null;
  if (!created) {
    const [existing] = await connection.select({ id: accountActivity.id })
      .from(accountActivity)
      .where(and(
        eq(accountActivity.userId, value.userId),
        eq(accountActivity.operationKey, value.operationKey),
      ))
      .limit(1);
    id = existing?.id ?? null;
  }
  logObservation({ event: 'activity.write', code: 'OK', count: created ? 1 : 0,
    ...(id ? { activityId: id.toString() } : {}) });
  return { created: Boolean(created), id: id?.toString() ?? null };
}
