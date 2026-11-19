import { and, eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db/drizzle';
import { member, organization } from '@/lib/db/auth-schema';

export function personalSlug(userId: string) {
  return `personal-${userId.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

async function findPersonalWorkspace(userId: string) {
  const rows = await db
    .select({ organization })
    .from(organization)
    .innerJoin(member, eq(member.organizationId, organization.id))
    .where(and(eq(member.userId, userId), eq(organization.slug, personalSlug(userId))))
    .limit(1);
  return rows[0]?.organization ?? null;
}

/** Recoverable, idempotent personal workspace bootstrap after registration. */
export async function ensurePersonalWorkspace(userId: string, name: string) {
  const existing = await findPersonalWorkspace(userId);
  if (existing) return existing;
  try {
    await auth.api.createOrganization({
      body: {
        name: `${name || 'My'} Workspace`,
        slug: personalSlug(userId),
        userId,
      },
    });
  } catch (error) {
    // A concurrent request may have created the same stable slug.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      const concurrent = await findPersonalWorkspace(userId);
      if (concurrent) return concurrent;
    }
    throw error;
  }
  const created = await findPersonalWorkspace(userId);
  if (!created) throw new Error('Personal workspace was not created.');
  return created;
}
