import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';

/**
 * Shared fixtures for the integration tests. Each test file runs against its own
 * database cloned from the migrated template (tests/support/database.ts), so a
 * fixture can only ever collide with one from the same file. `cleanupFixtures`
 * therefore exists to keep the child-first deletion rules in one place and to
 * prove a test leaves nothing behind, not to protect other files.
 */
const PREFIX = 'vitest';

export function uniqueSuffix(): string {
  return randomUUID();
}

export function scopedId(kind: string, suffix = uniqueSuffix()): string {
  return `${PREFIX}-${kind}-${suffix}`;
}

export function scopedEmail(suffix = uniqueSuffix()): string {
  return `${PREFIX}-${suffix}@example.test`;
}

/** Resolves the shared postgres-js client the application itself uses. */
export async function getClient(): Promise<Sql> {
  const { client } = await import('@/lib/db/drizzle');
  return client as unknown as Sql;
}

/** Resolves the shared drizzle instance the application itself uses. */
export async function getDb() {
  const { db } = await import('@/lib/db/drizzle');
  return db;
}

export type FixtureScope = {
  userIds?: string[];
  organizationIds?: string[];
  intentIds?: string[];
  rateLimitKeys?: string[];
  activityIds?: string[];
};

/**
 * Removes every fixture created by a test. Deletion is ordered child-first
 * because the billing and subscription tables use `ON DELETE RESTRICT`.
 */
export async function cleanupFixtures(scope: FixtureScope): Promise<void> {
  const client = await getClient();
  const users = scope.userIds ?? [];
  const organizations = scope.organizationIds ?? [];
  const intents = scope.intentIds ?? [];
  const rateLimitKeys = scope.rateLimitKeys ?? [];
  const activityIds = scope.activityIds ?? [];

  if (activityIds.length > 0) {
    await client`DELETE FROM account_activity WHERE id = ANY(${activityIds}::bigint[])`;
  }
  if (intents.length > 0) {
    // subscription_grants.evidence_id -> payment_evidence.id is ON DELETE
    // RESTRICT, so the grants have to go before the evidence they point at.
    await client`DELETE FROM subscription_grants WHERE evidence_id IN (
      SELECT id FROM payment_evidence WHERE intent_id = ANY(${intents}))`;
    await client`DELETE FROM payment_evidence WHERE intent_id = ANY(${intents})`;
    await client`DELETE FROM commission_grant_preparations WHERE intent_id = ANY(${intents})`;
    await client`DELETE FROM payment_intents WHERE id = ANY(${intents})`;
  }
  if (organizations.length > 0) {
    await client`DELETE FROM payment_inbox WHERE external_order_id LIKE ${`${PREFIX}-%`}
      AND center_order_id NOT IN (SELECT COALESCE(payment_center_order_id, '') FROM payment_intents)`;
    await client`DELETE FROM subscription_grants WHERE organization_id = ANY(${organizations})`;
    await client`DELETE FROM subscriptions WHERE organization_id = ANY(${organizations})`;
    await client`DELETE FROM billing_accounts WHERE organization_id = ANY(${organizations})`;
    await client`DELETE FROM member WHERE organization_id = ANY(${organizations})`;
  }
  if (users.length > 0) {
    await client`DELETE FROM referral_withdrawal_intents WHERE user_id = ANY(${users})`;
    await client`DELETE FROM payment_handshake_challenges WHERE site_code LIKE ${`${PREFIX}-%`}`;
  }
  if (rateLimitKeys.length > 0) {
    await client`DELETE FROM "rateLimit" WHERE key LIKE ANY(${rateLimitKeys})`;
  }
  if (organizations.length > 0) {
    await client`DELETE FROM organization WHERE id = ANY(${organizations})`;
  }
  if (users.length > 0) {
    await client`DELETE FROM "user" WHERE id = ANY(${users})`;
  }
}

/** Closes the shared pool. Every test file that touched the database calls it. */
export async function closeClient(): Promise<void> {
  const client = await getClient();
  await client.end({ timeout: 5 });
}

export type UserFixture = {
  suffix: string;
  userId: string;
  email: string;
};

/** Inserts a minimal auth user row, mirroring the smoke-script convention. */
export async function createUserFixture(options: {
  emailVerified?: boolean;
  marketingOptInRequested?: boolean;
  suffix?: string;
  id?: string;
} = {}): Promise<UserFixture> {
  const client = await getClient();
  const suffix = options.suffix ?? uniqueSuffix();
  const userId = options.id ?? scopedId('user', suffix);
  const email = scopedEmail(suffix);
  // `created_at` is written as a UTC wall clock on purpose: Better Auth inserts
  // a JS `Date`, which Drizzle maps to UTC, so that is the column's real
  // content. Leaving it to `defaultNow()` would stamp the session zone instead
  // and make a fresh row look eight hours old to `claimInvite`.
  await client`INSERT INTO "user" (id, name, email, email_verified, marketing_opt_in_requested, created_at)
    VALUES (${userId}, ${'Vitest Fixture'}, ${email},
      ${options.emailVerified ?? false}, ${options.marketingOptInRequested ?? false},
      (now() AT TIME ZONE 'UTC'))`;
  return { suffix, userId, email };
}

/** Inserts an organization plus its owner membership, returning both ids. */
export async function createOrganizationFixture(options: {
  userId: string;
  suffix?: string;
  /** Overrides the slug; pass `personalSlug(userId)` to look like a real personal workspace. */
  slug?: string;
}): Promise<{ organizationId: string; memberId: string }> {
  const client = await getClient();
  const suffix = options.suffix ?? uniqueSuffix();
  const organizationId = scopedId('org', suffix);
  const memberId = scopedId('member', suffix);
  await client`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${organizationId}, ${'Vitest Workspace'}, ${options.slug ?? organizationId}, now())`;
  await client`INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (${memberId}, ${organizationId}, ${options.userId}, ${'owner'}, now())`;
  return { organizationId, memberId };
}

/** True when the local PostgreSQL instance answers. */
export async function databaseReachable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    const client = await getClient();
    await client`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
