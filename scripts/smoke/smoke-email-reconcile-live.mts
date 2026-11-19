import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import postgres from 'postgres';

// This test runs workers directly against an empty, local SaaS database and
// a running local Email Center. Each run owns a new application and API key.
// It never starts a mail sender or changes a saved integration configuration.
const center = new URL(process.env.EMAIL_CENTER_URL || 'http://127.0.0.1:3100');
const centerConfig = dotenv.parse(readFileSync(resolve('..', 'email-center', '.env')));
for (const value of [center.href, process.env.DATABASE_URL!, centerConfig.POSTGRES_URL]) {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(value).hostname), 'Local services only');
}
assert.equal(center.protocol, 'http:', 'The local smoke uses HTTP');
assert.equal(center.pathname, '/');
assert.equal(center.search + center.hash + center.username + center.password, '');
assert.ok(centerConfig.UNSUBSCRIBE_SECRET, 'The local authority must have an unsubscribe signing secret');
assert.notEqual(process.env.NODE_ENV, 'production', 'Never run this synthetic fixture in production');

const suffix = randomUUID();
const apiKey = `ec_test_${randomBytes(24).toString('hex')}`;
process.env.FEATURE_EMAIL_CENTER = 'true';
process.env.EMAIL_CENTER_URL = center.origin;
process.env.EMAIL_CENTER_API_KEY = apiKey;
const { client } = await import('../../lib/db/drizzle');
const { runEmailContactSync } = await import('../../lib/email-center/worker');
const { runEmailContactReconcile, requeueEmailContact } = await import('../../lib/email-center/reconcile');
const { contactSnapshot, contactOperationKey } = await import('../../lib/email-center/contact');
const centerDb = postgres(centerConfig.POSTGRES_URL, { max: 2 });
let applicationId: number | null = null;
const users = new Set<string>();
const emails: string[] = [];
let sequence = 0;
let checks = 0;

type Event = {
  id: string; user_id: string; event_version: number; occurred_at: Date;
  status: string; attempt_count: number; last_error_code: string | null;
  last_reconcile_code: string | null; reconcile_after: Date | null;
  lease_owner: string | null; reconcile_lease_owner: string | null;
};
type Contact = {
  contact_id: number; contact_application_id: number; name: string;
  marketing_consent: boolean; marketing_suppressed_at: Date | null;
  status: string; consent_updated_at: Date; preferred_locale: string;
};
type Send = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const pathOf = (url: string | URL | Request) => new URL(url instanceof Request ? url.url : String(url)).pathname;

function traced(intercept?: Send) {
  const paths: string[] = [];
  const keys: string[] = [];
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URL(url instanceof Request ? url.url : String(url)).origin, center.origin);
    paths.push(pathOf(url));
    const key = new Headers(init?.headers).get('Idempotency-Key');
    if (key) keys.push(key);
    return intercept ? intercept(url, init) : fetch(url, init);
  }) as typeof fetch;
  return { send, paths, keys,
    writes: () => paths.filter((path) => path === '/api/v1/contacts/upsert').length,
    queries: () => paths.filter((path) => path === '/api/v1/contacts/reconcile').length };
}

async function event(id: string, version?: number): Promise<Event> {
  const [row] = await client<Event[]>`SELECT * FROM email_contact_outbox
    WHERE user_id = ${id} AND (${version ?? null}::integer IS NULL OR event_version = ${version ?? null})
    ORDER BY event_version DESC LIMIT 1`;
  assert.ok(row, 'Expected the transaction-created contact event');
  return row;
}
async function contact(id: string): Promise<Contact> {
  const [row] = await centerDb<Contact[]>`SELECT c.id AS contact_id, c.name,
    ca.id AS contact_application_id, ca.marketing_consent, ca.marketing_suppressed_at,
    ca.status, ca.consent_updated_at, ca.preferred_locale
    FROM contact_applications ca JOIN contacts c ON c.id = ca.contact_id
    WHERE ca.application_id = ${applicationId} AND ca.external_user_id = ${id}`;
  assert.ok(row, 'Expected an authority contact bound to the canonical user');
  return row;
}
async function receiptCount(id: string, version?: number) {
  const [{ count }] = await centerDb`SELECT count(*)::integer AS count FROM ingestion_events
    WHERE application_id = ${applicationId}
      AND idempotency_key LIKE ${`saas:contact:${id}:v${version ?? '%'}`}`;
  return count;
}
async function available(id: string) {
  await client`UPDATE email_contact_outbox SET available_at = now(), reconcile_after = now()
    WHERE user_id = ${id} AND status = 'pending'`;
}
async function forceReconcile(id: string, send?: typeof fetch) {
  const operation = await event(id);
  return runEmailContactReconcile({ userId: id, eventVersion: operation.event_version, force: true, maxJobs: 1, send });
}
async function fixture(run: (id: string) => Promise<void>) {
  const id = `email-reconcile-${suffix}-${++sequence}`;
  const email = `${id}@example.test`;
  users.add(id); emails.push(email);
  try {
    await client`INSERT INTO "user" (id, name, email, email_verified,
      marketing_opt_in_requested, preferred_locale, locale_source)
      VALUES (${id}, 'Reconcile Fixture', ${email}, true, true, 'en', 'user_selected')`;
    const [clock] = await client`SELECT EXTRACT(EPOCH FROM (occurred_at - now())) AS delta
      FROM email_contact_outbox WHERE user_id = ${id}`;
    assert.ok(Math.abs(Number(clock.delta)) < 5, 'New occurredAt must represent the current instant without a timezone shift');
    await run(id);
    checks++;
  } finally {
    await client`DELETE FROM "user" WHERE id = ${id}`;
    users.delete(id);
  }
}
function pause() {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { started, release, intercept: (async (url, init) => {
    entered();
    await gate;
    return fetch(url, init);
  }) as Send };
}
async function bounded<T>(action: Promise<T>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([action, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 2_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const loseAcceptedResponse: Send = async (url, init) => {
  const response = await fetch(url, init);
  if (pathOf(url) === '/api/v1/contacts/upsert') {
    assert.ok(response.ok, `Local authority upsert HTTP ${response.status}`);
    await response.json(); // Prove the native transaction completed before transport loss.
    throw new Error('SYNTHETIC_RESPONSE_LOSS');
  }
  return response;
};
async function unsubscribeToken(contactId: number) {
  // Use the authority's helper and alias scope, keeping its token off stdout
  // visible to the operator and out of URLs/access logs.
  const result = await promisify(execFile)(process.execPath, [
    '--import', pathToFileURL(resolve('node_modules', 'tsx', 'dist', 'loader.mjs')).href,
    '--input-type=module', '-e',
    "const mod=await import('./lib/security.ts'); const security=mod.default||mod; process.stdout.write(security.createUnsubscribeToken(JSON.parse(process.argv[1])));",
    JSON.stringify({ contactId, applicationId, scope: 'marketing' }),
  ], { cwd: resolve('..', 'email-center'), timeout: 15_000,
    env: { ...process.env, UNSUBSCRIBE_SECRET: centerConfig.UNSUBSCRIBE_SECRET } });
  return result.stdout;
}

async function withSlowAuthority(run: (paths: string[]) => Promise<void>) {
  const paths: string[] = [];
  const server = createServer((request) => {
    paths.push(new URL(request.url || '/', 'http://localhost').pathname);
    request.resume();
    // Keep the actual HTTP response open until the client aborts its budget.
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const previous = process.env.EMAIL_CENTER_URL;
  process.env.EMAIL_CENTER_URL = `http://127.0.0.1:${address.port}`;
  try {
    await run(paths);
  } finally {
    process.env.EMAIL_CENTER_URL = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

try {
  const [{ count }] = await client`SELECT count(*)::integer AS count FROM "user"`;
  assert.equal(count, 0, 'Stop other SaaS workers/tests and use an empty local database');
  const [application] = await centerDb`INSERT INTO applications
    (name, slug, description, api_key_prefix, api_key_hash, widget_key)
    VALUES ('Local reconciliation fixture', ${`reconcile-${suffix}`}, 'Synthetic local integration test',
      'ec_test_fixture', ${createHash('sha256').update(apiKey).digest('hex')}, ${`ec_pub_${randomBytes(16).toString('hex')}`})
    RETURNING id`;
  applicationId = Number(application.id);
  const ready = await fetch(new URL('/api/v1/integrations/verify', center), {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000),
  });
  assert.equal(ready.status, 200, 'Start the local Email Center server first');

  await fixture(async (id) => {
    const transport = traced(loseAcceptedResponse);
    assert.equal((await runEmailContactSync({ maxJobs: 1, send: transport.send })).retried, 1);
    assert.equal((await event(id)).status, 'pending');
    assert.equal(await receiptCount(id), 1, 'Native acceptance must exist despite the lost response');
    await available(id);
    const recovered = await runEmailContactSync({ maxJobs: 1, send: transport.send });
    assert.equal(recovered.reconciled, 1);
    assert.equal(recovered.succeeded, 0, 'Recovery must not execute another upsert');
    assert.equal(transport.writes(), 1);
    assert.equal(transport.queries(), 1);
    assert.equal(await receiptCount(id), 1);
    assert.equal((await event(id)).last_reconcile_code, 'MATCHED');
  });

  await fixture(async (id) => {
    const transport = traced(loseAcceptedResponse);
    await runEmailContactSync({ maxJobs: 1, send: transport.send });
    await client`UPDATE email_contact_outbox SET reconcile_after = now() WHERE user_id = ${id}`;
    const result = await runEmailContactReconcile({ maxJobs: 1, send: transport.send });
    assert.equal(result.confirmed, 1, 'The periodic runner must confirm a pending unknown outcome');
    assert.equal((await event(id)).status, 'succeeded');
    assert.equal((await event(id)).attempt_count, 1, 'Read-only reconciliation does not spend a send attempt');
    assert.equal(transport.writes(), 1);
    assert.equal(transport.queries(), 1);
    assert.equal(await receiptCount(id), 1);
  });

  await fixture(async (id) => {
    let unavailable = true;
    const transport = traced(async (url, init) => {
      if (unavailable && pathOf(url) === '/api/v1/contacts/upsert') {
        unavailable = false;
        return new Response(null, { status: 503, headers: { 'Retry-After': '1' } });
      }
      return fetch(url, init);
    });
    assert.equal((await runEmailContactSync({ maxJobs: 1, send: transport.send })).retried, 1);
    assert.equal(await receiptCount(id), 0);
    const [schedule] = await client`SELECT EXTRACT(EPOCH FROM (available_at - updated_at)) AS delay,
      EXTRACT(EPOCH FROM (available_at - now())) AS remaining
      FROM email_contact_outbox WHERE user_id = ${id}`;
    assert.ok(Number(schedule.delay) > 0.8 && Number(schedule.delay) < 1.2,
      'Persisted Retry-After must remain one second, including on an Asia/Shanghai PostgreSQL session');
    assert.ok(Number(schedule.remaining) > 0 && Number(schedule.remaining) <= 1.2,
      'Retry must stay scheduled in the future without an eight-hour offset');
    await available(id);
    assert.equal((await runEmailContactSync({ maxJobs: 1, send: transport.send })).succeeded, 1);
    assert.equal(transport.queries(), 1);
    assert.equal(transport.writes(), 2);
    assert.equal(transport.keys[0], transport.keys[1], 'A genuinely missing operation keeps its original key');
    assert.equal(await receiptCount(id), 1);
    assert.equal((await event(id)).last_reconcile_code, 'NOT_RECEIVED');
  });

  await fixture(async (id) => {
    assert.equal((await runEmailContactSync({ maxJobs: 1 })).succeeded, 1);
    const subscribed = await contact(id);
    assert.equal(subscribed.marketing_consent, true);
    const response = await fetch(new URL('/api/v1/unsubscribe', center), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: await unsubscribeToken(subscribed.contact_id) }),
    });
    assert.equal(response.status, 200, 'Exercise the real signed unsubscribe endpoint');
    const before = await contact(id);
    assert.equal(before.marketing_consent, false);
    assert.ok(before.marketing_suppressed_at);
    const [{ count: withdrawals }] = await centerDb`SELECT count(*)::integer AS count FROM consent_events
      WHERE contact_application_id = ${before.contact_application_id} AND event_type = 'withdrawn'`;
    assert.equal(withdrawals, 1);
    const transport = traced();
    assert.equal((await forceReconcile(id, transport.send)).confirmed, 1);
    assert.deepEqual(await contact(id), before, 'A read receipt must preserve every authority preference');
    assert.equal(transport.writes(), 0);
    assert.equal((await event(id)).last_reconcile_code, 'AUTHORITY_SUPPRESSED');
    assert.equal(await receiptCount(id), 1);
  });

  await fixture(async (id) => {
    const original = await event(id);
    const payload = await contactSnapshot(original);
    assert.ok(payload);
    const response = await fetch(new URL('/api/v1/contacts/upsert', center), {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json', 'Idempotency-Key': contactOperationKey(original) },
      body: JSON.stringify({ ...payload, name: 'Authority Profile' }),
    });
    assert.ok(response.ok, 'Seed an actual conflicting native receipt');
    await client`UPDATE email_contact_outbox SET attempt_count = 1 WHERE id = ${original.id}`;
    const transport = traced();
    assert.equal((await runEmailContactSync({ maxJobs: 1, send: transport.send })).deadLetter, 1);
    const blocked = await event(id);
    assert.equal(blocked.last_error_code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(blocked.status, 'dead_letter');
    assert.equal(blocked.reconcile_after, null);
    assert.equal(transport.writes(), 0);
    assert.equal((await contact(id)).name, 'Authority Profile');
    assert.equal(await receiptCount(id), 1);
    assert.equal((await requeueEmailContact(id, original.event_version, { send: transport.send })).action, 'not_requeued',
      'Manual recovery must not requeue an operation with a conflicting receipt');
    assert.equal(transport.writes(), 0);
  });

  await fixture(async (id) => {
    await client`UPDATE email_contact_outbox SET attempt_count = 1 WHERE user_id = ${id}`;
    const offline = traced(async () => new Response(null, {
      status: 503, headers: { 'Retry-After': '2' },
    }));
    assert.equal((await runEmailContactSync({ maxJobs: 1, send: offline.send })).retried, 1);
    assert.equal(offline.writes(), 0, 'An unreachable query does not prove the operation was missing');
    assert.equal((await event(id)).last_error_code, 'RECONCILE_HTTP_503');
    assert.equal(await receiptCount(id), 0);
    await available(id);
    const recovered = traced();
    assert.equal((await runEmailContactSync({ maxJobs: 1, send: recovered.send })).succeeded, 1);
    assert.equal(recovered.queries(), 1);
    assert.equal(recovered.writes(), 1);
  });

  await fixture(async (id) => {
    const timeout = traced(async () => new Response(null, { status: 408, headers: { 'Retry-After': '1' } }));
    assert.equal((await runEmailContactSync({ maxJobs: 1, send: timeout.send })).retried, 1);
    assert.equal((await event(id)).status, 'pending');
    await available(id);
    assert.equal((await runEmailContactSync({ maxJobs: 1, send: timeout.send })).retried, 1,
      'HTTP 408 from the receipt query must also remain recoverable');
    assert.equal((await event(id)).last_error_code, 'RECONCILE_HTTP_408');
    assert.equal(timeout.writes(), 1, 'No resend while the receipt query is timed out');
    assert.equal(await receiptCount(id), 0);
    await available(id);
    assert.equal((await runEmailContactSync({ maxJobs: 1 })).succeeded, 1);
  });

  await fixture(async (id) => {
    await client`UPDATE email_contact_outbox SET attempt_count = 1 WHERE user_id = ${id}`;
    const invalid = traced(async () => Response.json({ data: {
      applicationId, idempotencyKey: 'wrong-operation',
      operation: { status: 'not_received', requestMatches: false, contactApplicationId: null }, contact: null,
    } }));
    assert.equal((await runEmailContactSync({ maxJobs: 1, send: invalid.send })).deadLetter, 1);
    assert.equal((await event(id)).last_error_code, 'INVALID_RECONCILE_RESPONSE');
    assert.equal(invalid.writes(), 0);
    assert.equal(await receiptCount(id), 0);
  });

  await fixture(async (id) => {
    await runEmailContactSync({ maxJobs: 1 });
    const before = await contact(id);
    const offline = traced(async () => new Response(null, { status: 503, headers: { 'Retry-After': '1' } }));
    assert.equal((await forceReconcile(id, offline.send)).unreachable, 1);
    const stored = await event(id);
    assert.equal(stored.status, 'succeeded', 'A later query outage cannot erase a previously acknowledged delivery');
    assert.equal(stored.last_reconcile_code, 'RECONCILE_HTTP_503');
    assert.equal(stored.reconcile_lease_owner, null);
    assert.deepEqual(await contact(id), before);
    assert.equal((await forceReconcile(id)).confirmed, 1);
  });

  await fixture(async (id) => {
    const transport = traced(loseAcceptedResponse);
    await runEmailContactSync({ maxJobs: 1, send: transport.send });
    const original = await event(id);
    await client`UPDATE email_contact_outbox SET status = 'dead_letter', attempt_count = 8,
      last_error_code = 'NETWORK_OR_RESPONSE' WHERE id = ${original.id}`;
    assert.equal((await requeueEmailContact(id, original.event_version, { send: transport.send })).action, 'already_confirmed');
    assert.equal((await event(id)).status, 'succeeded');
    assert.equal((await event(id)).attempt_count, 8, 'Receipt recovery preserves send history');
    assert.equal(transport.writes(), 1);
    assert.equal(await receiptCount(id), 1);
  });

  await fixture(async (id) => {
    const original = await event(id);
    await client`UPDATE email_contact_outbox SET status = 'dead_letter', attempt_count = 8,
      last_error_code = 'HTTP_503' WHERE id = ${original.id}`;
    const transport = traced();
    assert.equal((await requeueEmailContact(id, original.event_version, { send: transport.send })).action, 'requeued');
    const queued = await event(id);
    assert.equal(queued.id, original.id);
    assert.equal(queued.status, 'pending');
    assert.equal(queued.attempt_count, 8);
    assert.equal((await runEmailContactSync({ maxJobs: 1, send: transport.send })).succeeded, 1);
    assert.equal((await event(id)).attempt_count, 9, 'One explicit recovery attempt adds to the retained history');
    assert.deepEqual(transport.keys, [contactOperationKey(original)]);
    assert.equal(await receiptCount(id), 1);
  });

  await fixture(async (id) => {
    const original = await event(id);
    await client`UPDATE email_contact_outbox SET status = 'dead_letter', attempt_count = 8,
      last_error_code = 'HTTP_503' WHERE id = ${original.id}`;
    const offline = traced(async () => new Response(null, { status: 503 }));
    assert.equal((await requeueEmailContact(id, original.event_version, { send: offline.send })).action, 'not_requeued');
    assert.equal((await event(id)).status, 'dead_letter', 'An unavailable authority cannot authorize a resend');
    assert.equal(offline.writes(), 0);
  });

  await fixture(async (id) => {
    await runEmailContactSync({ maxJobs: 1 });
    const original = await event(id);
    const payload = await contactSnapshot(original);
    assert.ok(payload);
    const response = await fetch(new URL('/api/v1/contacts/upsert', center), {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json', 'Idempotency-Key': `authority:profile:${id}` },
      body: JSON.stringify({ ...payload, name: 'Authority Newer Profile', marketingConsent: false,
        source: 'api', occurredAt: new Date(Date.now() + 1_000).toISOString() }),
    });
    assert.ok(response.ok);
    const before = await contact(id);
    const transport = traced();
    assert.equal((await forceReconcile(id, transport.send)).confirmed, 1);
    assert.equal((await event(id)).last_reconcile_code, 'REMOTE_PREFERENCE_CHANGED');
    assert.deepEqual(await contact(id), before, 'Reconciliation cannot replay local preference over a newer remote choice');
    assert.equal(transport.writes(), 0);
  });

  await fixture(async (id) => {
    await runEmailContactSync({ maxJobs: 1 });
    const original = await event(id);
    const payload = await contactSnapshot(original);
    assert.ok(payload);
    const nextEmail = `${id}-rebound@example.test`;
    emails.push(nextEmail);
    const response = await fetch(new URL('/api/v1/contacts/upsert', center), {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json', 'Idempotency-Key': `authority:binding:${id}` },
      body: JSON.stringify({ ...payload, email: nextEmail, source: 'api',
        occurredAt: new Date(Date.now() + 1_000).toISOString() }),
    });
    assert.ok(response.ok);
    const before = await contact(id);
    const transport = traced();
    assert.equal((await forceReconcile(id, transport.send)).conflicts, 1);
    assert.equal((await event(id)).status, 'succeeded', 'Keep the historical successful receipt and flag current binding drift');
    assert.equal((await event(id)).last_reconcile_code, 'REMOTE_BINDING_MISMATCH');
    assert.deepEqual(await contact(id), before);
    assert.equal(transport.writes(), 0);
  });

  await fixture(async (id) => {
    await runEmailContactSync({ maxJobs: 1 });
    const original = await event(id);
    const paused = pause();
    const transport = traced(paused.intercept);
    const pending = forceReconcile(id, transport.send);
    try {
      await bounded(paused.started, 'Reconciler did not reach its HTTP query');
      const leased = await event(id);
      assert.ok(leased.reconcile_lease_owner);
      await bounded(client`UPDATE email_contact_outbox SET updated_at = updated_at WHERE id = ${original.id}`,
        'Reconciliation kept its claimed outbox row locked across HTTP');
      await bounded(client`UPDATE "user" SET name = 'Newer While Querying' WHERE id = ${id}`,
        'Reconciliation held a database transaction across HTTP');
      assert.equal((await event(id)).event_version, original.event_version + 1);
      assert.equal((await runEmailContactSync({ maxJobs: 1 })).claimed, 0,
        'A newer version must wait for an active reconciliation lease');
      assert.equal((await runEmailContactReconcile({ maxJobs: 1 })).checked, 0,
        'Two reconcilers must not query the same active user');
    } finally { paused.release(); }
    assert.equal((await pending).confirmed, 1);
    assert.equal(transport.writes(), 0);
    assert.equal((await runEmailContactSync({ maxJobs: 1 })).succeeded, 1);
    assert.equal((await contact(id)).name, 'Newer While Querying');
    assert.equal(await receiptCount(id), 2, 'Exactly the two distinct event versions should exist');
  });

  await fixture(async (id) => {
    const paused = pause();
    const transport = traced(paused.intercept);
    const pending = runEmailContactSync({ maxJobs: 1, send: transport.send });
    try {
      await bounded(paused.started, 'Sync worker did not reach its HTTP send');
      const leased = await event(id);
      assert.equal(leased.status, 'processing');
      await bounded(client`UPDATE email_contact_outbox SET updated_at = updated_at WHERE id = ${leased.id}`,
        'Sync kept its claimed outbox row locked across HTTP');
      await bounded(client`UPDATE "user" SET name = 'Newer While Sending' WHERE id = ${id}`,
        'Sync held a database transaction across HTTP');
      assert.equal((await runEmailContactSync({ maxJobs: 1 })).claimed, 0);
      assert.equal((await runEmailContactReconcile({ maxJobs: 1 })).checked, 0);
    } finally { paused.release(); }
    assert.equal((await pending).succeeded, 1);
    assert.equal((await runEmailContactSync({ maxJobs: 1 })).succeeded, 1);
    assert.equal((await contact(id)).name, 'Newer While Sending');
    assert.equal(await receiptCount(id), 2);
  });

  await fixture(async (id) => {
    await runEmailContactSync({ maxJobs: 1 });
    await client`UPDATE email_contact_outbox SET reconcile_lease_owner = 'expired-fixture',
      reconcile_lease_expires_at = now() - interval '1 second' WHERE user_id = ${id}`;
    assert.equal((await forceReconcile(id)).confirmed, 1, 'A crashed reconcile lease must be reclaimable');
    assert.equal((await event(id)).reconcile_lease_owner, null);
    await client`UPDATE email_contact_outbox SET status = 'processing', lease_owner = 'expired-fixture',
      lease_expires_at = now() - interval '1 second' WHERE user_id = ${id}`;
    const transport = traced();
    assert.equal((await runEmailContactSync({ maxJobs: 1, send: transport.send })).reconciled, 1,
      'A crashed send must check the existing native receipt before resending');
    assert.equal(transport.writes(), 0);
    assert.equal((await event(id)).lease_owner, null);
    assert.equal(await receiptCount(id), 1);
  });

  await fixture(async (id) => {
    const offline = traced(async () => new Response(null, { status: 503 }));
    await runEmailContactSync({ maxJobs: 1, send: offline.send });
    const original = await event(id);
    await client`UPDATE "user" SET name = 'Latest Snapshot Only' WHERE id = ${id}`;
    assert.equal(await contactSnapshot(original), null, 'An old key cannot borrow a newer profile');
    const transport = traced();
    assert.equal((await runEmailContactSync({ maxJobs: 1, send: transport.send })).succeeded, 1);
    assert.equal((await event(id, original.event_version)).status, 'superseded');
    assert.equal(transport.queries(), 0, 'Never retry an obsolete profile version');
    assert.equal((await contact(id)).name, 'Latest Snapshot Only');
    assert.equal(await receiptCount(id, original.event_version), 0);
    assert.equal(await receiptCount(id), 1);
  });

  await fixture(async (id) => {
    await client`UPDATE email_contact_outbox SET attempt_count = 1 WHERE user_id = ${id}`;
    await withSlowAuthority(async (paths) => {
      const started = Date.now();
      const result = await runEmailContactSync({ maxJobs: 25, maxMillis: 300 });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 150 && elapsed < 1_200,
        'The batch budget must abort a real slow receipt query before its separate four-second timeout');
      assert.deepEqual(paths, ['/api/v1/contacts/reconcile'], 'An aborted query never proves not-received or grants an upsert');
      assert.equal(result.claimed, 1);
      assert.equal(result.retried, 1);
      assert.equal(result.succeeded + result.reconciled + result.deadLetter, 0);
      const stored = await event(id);
      assert.equal(stored.status, 'pending');
      assert.equal(stored.last_error_code, 'RECONCILE_NETWORK_OR_RESPONSE');
      assert.equal(stored.last_reconcile_code, 'RECONCILE_NETWORK_OR_RESPONSE');
      assert.equal(stored.attempt_count, 2);
      assert.equal(stored.lease_owner, null);
      assert.equal(stored.reconcile_lease_owner, null);
    });
    assert.equal(await receiptCount(id), 0);
  });

  await fixture(async (id) => {
    assert.equal((await runEmailContactSync({ maxJobs: 1 })).succeeded, 1);
    const original = await event(id);
    const before = await contact(id);
    await withSlowAuthority(async (paths) => {
      const started = Date.now();
      const result = await runEmailContactReconcile({
        userId: id, eventVersion: original.event_version, force: true, maxJobs: 1, maxMillis: 300,
      });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 150 && elapsed < 1_200,
        'The independent reconcile runner must also abort a real HTTP query within its batch budget');
      assert.deepEqual(paths, ['/api/v1/contacts/reconcile']);
      assert.equal(result.checked, 1);
      assert.equal(result.unreachable, 1);
      assert.equal(result.confirmed + result.notReceived + result.conflicts, 0);
      const stored = await event(id);
      assert.equal(stored.status, 'succeeded', 'A timed-out query cannot erase historical acknowledged delivery');
      assert.equal(stored.attempt_count, original.attempt_count);
      assert.equal(stored.last_reconcile_code, 'RECONCILE_NETWORK_OR_RESPONSE');
      assert.equal(stored.lease_owner, null);
      assert.equal(stored.reconcile_lease_owner, null);
    });
    assert.deepEqual(await contact(id), before, 'A batch timeout changes no authoritative contact or consent');
    assert.equal(await receiptCount(id), 1);
  });

  console.log(`Email Center native receipt recovery passed (${checks} local scenarios): lost response, periodic recovery, original-key resend, signed unsubscribe, conflicts, unavailable/invalid query, shared leases, crash recovery, version ordering and real HTTP batch-budget aborts.`);
} finally {
  for (const id of users) await client`DELETE FROM "user" WHERE id = ${id}`;
  if (applicationId) {
    await centerDb`DELETE FROM audit_logs WHERE application_id = ${applicationId}`;
    await centerDb`DELETE FROM applications WHERE id = ${applicationId}`;
  }
  if (emails.length) await centerDb`DELETE FROM contacts WHERE normalized_email IN ${centerDb(emails)}`;
  await centerDb.end({ timeout: 5 });
  await client.end({ timeout: 5 });
}
