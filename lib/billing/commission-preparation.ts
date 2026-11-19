import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { commissionGrantPreparations, paymentIntents } from '@/lib/db/integration-schema';
import {
  assertOrderMatchesIntent, intentPaymentAction, type CenterOrder,
} from '@/lib/payment-center/orders';

export class CommissionPreparationConflict extends Error {}

export async function prepareCommissionGrant(intentId: string, order: CenterOrder) {
  return db.transaction(async (tx) => {
    const [intent] = await tx.select().from(paymentIntents)
      .where(eq(paymentIntents.id, intentId)).limit(1);
    if (!intent || intentPaymentAction(intent) !== 'commission_reserved' ||
        !['month', 'year'].includes(intent.priceInterval) ||
        order.status !== 'action_required') {
      throw new CommissionPreparationConflict('Commission order cannot prepare a paid period');
    }
    assertOrderMatchesIntent(intent, order);
    const spendId = order.payment_details?.commission_spend_id;
    if (typeof spendId !== 'string' || spendId !== `PC_${order.id}`) {
      throw new CommissionPreparationConflict('Commission spend ID does not match the order');
    }
    const locked = await tx.execute(sql`SELECT id FROM organization
      WHERE id = ${intent.organizationId} FOR UPDATE`);
    if (!locked.length) throw new CommissionPreparationConflict('Workspace no longer exists');
    const [existing] = await tx.select().from(commissionGrantPreparations)
      .where(eq(commissionGrantPreparations.intentId, intent.id)).limit(1);
    if (existing) {
      if (existing.centerOrderId !== order.id || existing.spendId !== spendId ||
          existing.organizationId !== intent.organizationId || existing.status === 'cancelled') {
        throw new CommissionPreparationConflict('Commission grant preparation conflicts with the order');
      }
      return existing;
    }
    const [other] = await tx.select({ intentId: commissionGrantPreparations.intentId })
      .from(commissionGrantPreparations).where(and(
        eq(commissionGrantPreparations.organizationId, intent.organizationId),
        eq(commissionGrantPreparations.status, 'prepared'),
      )).limit(1);
    if (other) throw new CommissionPreparationConflict('Workspace has another prepared commission order');
    const [created] = await tx.insert(commissionGrantPreparations).values({
      intentId: intent.id,
      organizationId: intent.organizationId,
      centerOrderId: order.id,
      spendId,
    }).returning();
    return created;
  });
}

export async function markCommissionPreparation(intentId: string,
  status: 'confirmed' | 'cancelled') {
  await db.update(commissionGrantPreparations).set({ status, updatedAt: new Date() })
    .where(and(eq(commissionGrantPreparations.intentId, intentId),
      eq(commissionGrantPreparations.status, 'prepared')));
}
