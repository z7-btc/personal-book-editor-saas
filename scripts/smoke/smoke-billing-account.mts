import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const { client } = await import('../../lib/db/drizzle');
const { BillingAccessError, ensureBillingAccount } = await import('../../lib/billing/account');

const suffix = randomUUID();
const ownerId = `billing-owner-${suffix}`;
const memberId = `billing-member-${suffix}`;
const organizationId = `billing-org-${suffix}`;

try {
  await client`INSERT INTO "user" (id, name, email) VALUES
    (${ownerId}, 'Billing Owner', ${`${ownerId}@example.test`}),
    (${memberId}, 'Billing Member', ${`${memberId}@example.test`})`;
  await client`INSERT INTO organization (id, name, slug, created_at)
    VALUES (${organizationId}, 'Billing Smoke', ${`billing-${suffix}`}, now())`;
  await client`INSERT INTO member (id, organization_id, user_id, role, created_at)
    VALUES (${randomUUID()}, ${organizationId}, ${ownerId}, 'owner', now()),
           (${randomUUID()}, ${organizationId}, ${memberId}, 'member', now())`;

  const [first, second] = await Promise.all([
    ensureBillingAccount(organizationId, ownerId),
    ensureBillingAccount(organizationId, ownerId),
  ]);
  assert.equal(first.id, second.id);
  assert.equal(first.originalPayerUserId, ownerId);
  assert.equal(first.externalBillingId, first.id);
  const [{ count }] = await client`SELECT count(*)::int AS count FROM billing_accounts
    WHERE organization_id = ${organizationId}`;
  assert.equal(count, 1);
  await assert.rejects(ensureBillingAccount(organizationId, memberId), BillingAccessError);
  console.log('Concurrent billing identity and owner-only access passed.');
} finally {
  await client`DELETE FROM billing_accounts WHERE organization_id = ${organizationId}`;
  await client`DELETE FROM organization WHERE id = ${organizationId}`;
  await client`DELETE FROM "user" WHERE id IN (${ownerId}, ${memberId})`;
  await client.end({ timeout: 5 });
}
