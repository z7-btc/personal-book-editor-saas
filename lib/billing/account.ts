import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { member } from '@/lib/db/auth-schema';
import { billingAccounts } from '@/lib/db/integration-schema';

export class BillingAccessError extends Error {}

export async function ensureBillingAccount(organizationId: string, actorUserId: string) {
  const [membership] = await db.select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, actorUserId)))
    .limit(1);
  if (membership?.role !== 'owner') {
    throw new BillingAccessError('Personal billing requires the account owner');
  }

  const id = `ba_${randomUUID().replaceAll('-', '')}`;
  await db.insert(billingAccounts).values({
    id,
    organizationId,
    externalBillingId: id,
    originalPayerUserId: actorUserId,
  }).onConflictDoNothing({ target: billingAccounts.organizationId });

  const [account] = await db.select().from(billingAccounts)
    .where(eq(billingAccounts.organizationId, organizationId)).limit(1);
  if (!account) throw new Error('Billing account could not be created');
  if (account.originalPayerUserId !== actorUserId) {
    throw new BillingAccessError('Personal billing belongs to another user');
  }
  return account;
}
