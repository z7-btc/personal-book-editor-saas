import 'server-only';
import { and, desc, eq, lt, lte } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db/drizzle';
import { accountActivity } from '@/lib/db/activity-schema';
import { activityCategory, type ActivityFeed } from './events';
import { decodeActivityCursor, encodeActivityCursor } from './cursor';

// Identity comes only from Better Auth. A browser-supplied user or organization
// identifier is not an argument to this DAL and can never change its scope.
export async function getAccountActivity(requestHeaders: Headers,
  options: { cursor?: string; limit?: number } = {}): Promise<ActivityFeed | null> {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('INVALID_LIMIT');
  const cursor = options.cursor ? decodeActivityCursor(session.user.id, options.cursor) : null;
  const rows = await db.select({ id: accountActivity.id, type: accountActivity.eventType,
    occurredAt: accountActivity.occurredAt }).from(accountActivity).where(and(
    eq(accountActivity.userId, session.user.id),
    ...(cursor ? [lt(accountActivity.id, BigInt(cursor.before)), lte(accountActivity.id, BigInt(cursor.ceiling))] : []),
  )).orderBy(desc(accountActivity.id)).limit(limit + 1);
  const visible = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return {
    items: visible.map((row) => ({ id: row.id.toString(), type: row.type,
      category: activityCategory(row.type), occurredAt: row.occurredAt.toISOString() })),
    nextCursor: hasMore ? encodeActivityCursor(session.user.id, visible[visible.length - 1].id.toString(),
      cursor?.ceiling ?? visible[0].id.toString()) : null,
  };
}
