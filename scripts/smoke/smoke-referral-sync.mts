import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'dotenv/config';

const { client } = await import('../../lib/db/drizzle');

if (process.env.NODE_ENV === 'production') {
  throw new Error('This smoke is restricted to a local development database.');
}

const [existing] = await client`
  SELECT count(*)::integer AS count FROM referral_user_outbox
  WHERE status IN ('pending', 'processing')
`;
if (existing.count !== 0) {
  console.error(`[smoke:referral-sync] blocked: ${existing.count} referral job(s) are already pending or processing; this smoke only runs against an idle queue so it cannot consume real jobs. Drain the queue (npm run worker) or point it at a fresh database.`);
  process.exit(2);
}

const suffix = randomUUID();
const inviterId = `smoke-inviter-${suffix}`;
const referredId = `smoke-referred-${suffix}`;

try {
  await client`
    INSERT INTO "user" (id, name, email, created_at, updated_at)
    VALUES (${inviterId}, 'Smoke Inviter', ${`smoke-inviter-${suffix}@example.invalid`},
            timezone('UTC', now()), timezone('UTC', now()))
  `;
  await client`
    INSERT INTO "user" (id, name, email, created_at, updated_at)
    VALUES (${referredId}, 'Smoke Referred', ${`smoke-referred-${suffix}@example.invalid`},
            timezone('UTC', now()), timezone('UTC', now()))
  `;
  const profiles = await client`
    SELECT user_id, invite_code, sync_version FROM referral_profiles
    WHERE user_id IN (${inviterId}, ${referredId}) ORDER BY user_id
  `;
  assert.equal(profiles.length, 2);
  assert.ok(profiles.every((profile) => /^SF[0-9A-F]{32}$/.test(profile.invite_code)));
  const inviterCode = profiles.find((profile) => profile.user_id === inviterId)!.invite_code;

  let mismatchedCodeRejected = false;
  try {
    await client`
      INSERT INTO referral_attributions (user_id, inviter_user_id, invite_code)
      VALUES (${referredId}, ${inviterId}, 'SF00000000000000000000000000000000')
    `;
  } catch {
    mismatchedCodeRejected = true;
  }
  assert.equal(mismatchedCodeRejected, true);

  let codeChangeRejected = false;
  try {
    await client`
      UPDATE referral_profiles SET invite_code = 'SF00000000000000000000000000000000'
      WHERE user_id = ${inviterId}
    `;
  } catch {
    codeChangeRejected = true;
  }
  assert.equal(codeChangeRejected, true);

  process.env.FEATURE_REFERRALS = 'true';
  process.env.PAYMENT_CENTER_BASE_URL = 'http://127.0.0.1:5000';
  process.env.PAYMENT_CENTER_WEBSITE_ID = 'local-smoke-site';
  process.env.PAYMENT_CENTER_REFERRAL_API_KEY = 'local-smoke-only';
  const { resolveInviteCode, claimInvite, verifyInviteTicket } =
    await import('../../lib/referrals/invite');
  const lookup: typeof fetch = async () => Response.json({ data: {
    valid: true, invite_code: inviterCode, external_user_id: inviterId,
    cookie_days: 30,
  } });
  const invitation = await resolveInviteCode(inviterCode, lookup);
  assert.ok(invitation);
  const wrongSiteIdentity: typeof fetch = async () => Response.json({ data: {
    valid: true, invite_code: inviterCode, external_user_id: 'another-site-user',
    cookie_days: 30,
  } });
  assert.equal(await resolveInviteCode(inviterCode, wrongSiteIdentity), null);
  assert.equal(verifyInviteTicket(`${invitation.ticket}x`), null);
  assert.equal(await claimInvite(inviterId, invitation.ticket), 'self');
  await client`
    UPDATE "user" SET created_at = now() - interval '2 days'
    WHERE id = ${referredId}
  `;
  assert.equal(await claimInvite(referredId, invitation.ticket), 'existing_account');
  // A stamp that sits in the future cannot be placed after the ticket was
  // issued, so the claim stays unprovable until the clock catches up.
  await client`UPDATE "user" SET created_at = now() + interval '2 days' WHERE id = ${referredId}`;
  assert.equal(await claimInvite(referredId, invitation.ticket), 'existing_account');
  await client`UPDATE "user" SET created_at = now() WHERE id = ${referredId}`;
  assert.equal(await claimInvite(referredId, invitation.ticket), 'claimed');
  assert.equal(await claimInvite(referredId, invitation.ticket), 'already_claimed');
  const [version] = await client`
    SELECT sync_version FROM referral_profiles WHERE user_id = ${referredId}
  `;
  assert.equal(version.sync_version, 2);

  let rejected = false;
  try {
    await client`
      UPDATE referral_attributions SET inviter_user_id = ${referredId}
      WHERE user_id = ${referredId}
    `;
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true, 'attribution update must be rejected by PostgreSQL');

  const { runReferralUserSync } = await import('../../lib/referrals/worker');
  const sent: Array<Record<string, unknown>> = [];
  const fakeSend: typeof fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    sent.push(body);
    return Response.json({ data: { user: {
      website_id: 'local-smoke-site',
      external_user_id: body.external_user_id,
      invite_code: body.invite_code,
      referred_by_id: body.referred_by_invite_code ? 'remote-inviter' : null,
    } } });
  };
  const report = await runReferralUserSync({ maxJobs: 4, send: fakeSend });
  assert.equal(report.succeeded, 2);
  assert.equal(report.claimed, 2);
  assert.equal(sent.length, 2);
  assert.equal(sent.find((body) => body.external_user_id === referredId)
    ?.referred_by_invite_code, inviterCode);
  const rows = await client`
    SELECT event_version, status FROM referral_user_outbox
    WHERE user_id = ${referredId} ORDER BY event_version
  `;
  assert.deepEqual(rows.map((row) => row.status), ['superseded', 'succeeded']);
  console.log('Signed invite claim, immutable attribution, coalesced outbox and scoped sync passed.');
} finally {
  await client`DELETE FROM "user" WHERE id IN (${inviterId}, ${referredId})`;
  await client.end();
}
