import 'dotenv/config';
import assert, { AssertionError } from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Run with: npx tsx scripts/smoke-email-timezone-migration.mts
// Administrative psql uses the already authorized local passwordless account.
// Neither saved DATABASE_URL nor passwords are written to files or logs. Only
// strictly named random databases created by this process can be dropped.
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(workspace, 'lib', 'db', 'migrations');
const psql = 'D:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe';
const runId = randomBytes(12).toString('hex');
const databaseNames = [`saas_tz_fresh_${runId}`, `saas_tz_upgrade_${runId}`] as const;
const ownedDatabases = new Set<string>();
const clients: Array<ReturnType<typeof postgres>> = [];
const appUrl = new URL(process.env.DATABASE_URL || 'invalid://missing');
const originalNodeTimeZone = process.env.TZ;
assert.notEqual(process.env.NODE_ENV, 'production', 'Synthetic migration fixtures are local only');
assert.ok(['postgresql:', 'postgres:'].includes(appUrl.protocol), 'A PostgreSQL DATABASE_URL is required');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(appUrl.hostname), 'Local PostgreSQL only');
assert.equal(appUrl.port || '5432', '5432', 'Use the authorized default PostgreSQL port');
const owner = decodeURIComponent(appUrl.username);
assert.ok(owner.length > 0 && owner.length <= 63 && !owner.includes('\0'), 'The existing application role is required');
let temporaryMigrations: string | null = null;
let phase = 'preflight';
let failure: unknown;
let cleanupFailures = 0;

type Journal = {
  version: string; dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};
type FixtureRow = {
  id: string; user_id: string; event_version: number; status: string; attempt_count: number;
  occurred_at: Date | string; available_at: Date | string; lease_expires_at: Date | string | null;
  created_at: Date | string; updated_at: Date | string; name: string; email: string;
  email_verified: boolean; preferred_locale: string; locale_source: string;
  marketing_opt_in_requested: boolean;
  expected_occurred_ms?: string; expected_available_ms?: string;
  expected_lease_ms?: string | null; expected_created_ms?: string; expected_updated_ms?: string;
};
const timeColumns = ['occurred_at', 'available_at', 'lease_expires_at', 'created_at', 'updated_at',
  'last_reconciled_at', 'reconcile_after', 'reconcile_lease_expires_at'];
const labels = ['unsent', 'retry', 'processing', 'succeeded', 'dead-letter'] as const;

function identifier(value: string) { return `"${value.replaceAll('"', '""')}"`; }
function literal(value: string) { return `'${value.replaceAll("'", "''")}'`; }
// Drizzle's postgres-js adapter makes date parsers transparent. The production
// worker explicitly constructs Date too; never assume raw SQL returns Date.
function milliseconds(value: Date | string) { return new Date(value).getTime(); }
function safeFailureCode(error: unknown): string | null {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[A-Z0-9_]{5,40}$/.test(candidate.code)) return candidate.code;
    current = candidate.cause;
  }
  return null;
}
function validateDatabaseName(name: string) {
  assert.ok(databaseNames.includes(name as typeof databaseNames[number]), 'Only this run owns this database');
  assert.match(name, /^saas_tz_(?:fresh|upgrade)_[a-f0-9]{24}$/, 'Strict temporary database prefix');
  assert.notEqual(name, decodeURIComponent(appUrl.pathname.slice(1)), 'Never mutate the application database');
}
function admin(query: string) {
  const environment = { ...process.env };
  delete environment.PGPASSWORD;
  delete environment.PGSERVICE;
  const result = spawnSync(psql, ['-X', '-w', '-q', '-A', '-t', '-h', '127.0.0.1', '-p', '5432',
    '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input: query, encoding: 'utf8', env: environment, timeout: 30_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('LOCAL_ADMIN_PSQL_FAILED');
  return result.stdout.trim();
}
async function createDatabase(name: string) {
  validateDatabaseName(name);
  assert.equal(admin(`SELECT count(*) FROM pg_database WHERE datname = ${literal(name)};`), '0',
    'Random test database must not preexist');
  // Record ownership before CREATE so a successfully committed but interrupted
  // administrative command still gets checked and cleaned in finally.
  ownedDatabases.add(name);
  admin(`CREATE DATABASE ${identifier(name)} OWNER ${identifier(owner)} TEMPLATE template0;`);
  return connectDatabase(name);
}
async function connectDatabase(name: string, oldRunnerZone?: 'UTC') {
  validateDatabaseName(name);
  assert.ok(ownedDatabases.has(name), 'Only this run can reconnect to a fixture database');
  const url = new URL(appUrl.href);
  url.pathname = `/${name}`;
  if (oldRunnerZone) {
    const previousOptions = url.searchParams.get('options') || '';
    url.searchParams.set('options', `${previousOptions} -c saas.legacy_email_runner_timezone=${oldRunnerZone}`.trim());
  }
  const sql = postgres(url.href, { max: 1, connect_timeout: 5, idle_timeout: 5, onnotice: () => {} });
  clients.push(sql);
  const [environment] = await sql`SELECT current_database() AS database, current_user AS role,
    current_setting('TimeZone') AS zone`;
  assert.equal(environment.database, name, 'Every application query must target its temporary database');
  assert.equal(environment.role, owner, 'Migrations run as the existing application role');
  assert.equal(environment.zone, 'Asia/Shanghai', 'Exercise the real non-UTC database default');
  if (oldRunnerZone) {
    const [setting] = await sql`SELECT current_setting('saas.legacy_email_runner_timezone') AS zone`;
    assert.equal(setting.zone, oldRunnerZone, 'The migration override must come from connection startup options');
  }
  return sql;
}
async function journalSnapshot(sql: ReturnType<typeof postgres>) {
  return sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
}
async function assertSchema(sql: ReturnType<typeof postgres>, journal: Journal) {
  const history = await journalSnapshot(sql);
  assert.equal(history.length, 20, 'All 20 canonical migrations must be applied');
  for (let index = 0; index < journal.entries.length; index++) {
    assert.equal(Number(history[index].created_at), journal.entries[index].when, 'Migration timestamps must match the canonical journal');
    const bytes = await readFile(join(source, `${journal.entries[index].tag}.sql`));
    assert.equal(history[index].hash, createHash('sha256').update(bytes).digest('hex'),
      'Migration hashes must match the canonical SQL files');
  }
  const columns = await sql`SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'email_contact_outbox'
      AND column_name IN ${sql(timeColumns)} ORDER BY column_name`;
  assert.equal(columns.length, timeColumns.length, 'All queue time columns must exist');
  for (const column of columns) assert.equal(column.data_type, 'timestamp with time zone',
    `Queue ${column.column_name} must retain its timezone`);
  const [active] = await sql`SELECT i.indisunique AS unique, pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'email_contact_outbox_one_active_per_user'`;
  assert.equal(active?.unique, true, 'The shared send/reconcile guard must be unique');
  assert.match(active.predicate, /status.*processing/s, 'The index must guard sending');
  assert.match(active.predicate, /reconcile_lease_owner IS NOT NULL/, 'The index must guard reconciliation');
  const [legacy] = await sql`SELECT count(*)::integer AS count FROM pg_class
    WHERE relname = 'email_contact_outbox_one_processing_per_user'`;
  assert.equal(legacy.count, 0, 'The superseded send-only index must be gone');
}
function wire(row: FixtureRow) {
  const payload = {
    externalUserId: row.user_id, email: row.email, name: row.name,
    source: row.event_version === 1 ? 'registration' : 'api',
    occurredAt: new Date(row.occurred_at).toISOString(),
    preferredLocale: row.preferred_locale === 'zh-CN' ? 'zh-CN' : 'en',
    localeSource: row.locale_source || 'fallback',
    marketingConsent: Boolean(row.email_verified && row.marketing_opt_in_requested), metadata: {},
  };
  return { key: `saas:contact:${row.user_id}:v${row.event_version}`,
    iso: payload.occurredAt, hash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}
async function rowSnapshot(sql: ReturnType<typeof postgres>) {
  return sql<FixtureRow[]>`SELECT e.*, u.name, u.email, u.email_verified, u.preferred_locale,
    u.locale_source, u.marketing_opt_in_requested FROM email_contact_outbox e
    INNER JOIN "user" u ON u.id = e.user_id ORDER BY e.user_id`;
}
async function seedLegacyEvent(sql: ReturnType<typeof postgres>, label: string, attempts: number,
  status: string, baseIso: string) {
  const id = `tz-${label}-${runId}`;
  await sql`INSERT INTO "user" (id, name, email, email_verified, preferred_locale,
    locale_source, marketing_opt_in_requested) VALUES (${id}, 'Synthetic timezone fixture',
    ${`${id}@example.test`}, true, 'en', 'user_selected', true)`;
  await sql`UPDATE email_contact_outbox SET attempt_count = ${attempts},
    status = ${status}::email_outbox_status,
    occurred_at = (${baseIso}::timestamptz - interval '60 seconds') AT TIME ZONE 'Asia/Shanghai',
    available_at = CASE WHEN ${attempts} > 0 AND ${status} <> 'processing'
      THEN (${baseIso}::timestamptz + interval '120 seconds') AT TIME ZONE 'UTC'
      ELSE (${baseIso}::timestamptz + interval '120 seconds') AT TIME ZONE 'Asia/Shanghai' END,
    lease_owner = CASE WHEN ${status} = 'processing' THEN 'synthetic-processing' ELSE NULL END,
    lease_expires_at = CASE WHEN ${status} = 'processing'
      THEN (${baseIso}::timestamptz + interval '30 seconds') AT TIME ZONE 'Asia/Shanghai' ELSE NULL END,
    created_at = (${baseIso}::timestamptz - interval '180 seconds') AT TIME ZONE 'Asia/Shanghai',
    updated_at = ${baseIso}::timestamptz AT TIME ZONE 'Asia/Shanghai'
    WHERE user_id = ${id} AND event_version = 1`;
}
async function assertUniqueActiveGuard(sql: ReturnType<typeof postgres>) {
  const id = `tz-index-${runId}`;
  await sql`INSERT INTO "user" (id, name, email) VALUES (${id}, 'Synthetic index fixture', ${`${id}@example.test`})`;
  await sql`INSERT INTO email_contact_outbox (user_id, event_version, occurred_at) VALUES (${id}, 2, now())`;
  await sql`UPDATE email_contact_outbox SET status = 'processing' WHERE user_id = ${id} AND event_version = 1`;
  await assert.rejects(sql`UPDATE email_contact_outbox SET reconcile_lease_owner = 'synthetic-lease'
    WHERE user_id = ${id} AND event_version = 2`, (error: unknown) => (error as { code?: string }).code === '23505',
  'A sender must exclude a concurrent reconciliation lease');
  await sql`UPDATE email_contact_outbox SET status = 'pending' WHERE user_id = ${id} AND event_version = 1`;
  await sql`UPDATE email_contact_outbox SET reconcile_lease_owner = 'synthetic-lease'
    WHERE user_id = ${id} AND event_version = 2`;
  await assert.rejects(sql`UPDATE email_contact_outbox SET status = 'processing'
    WHERE user_id = ${id} AND event_version = 1`, (error: unknown) => (error as { code?: string }).code === '23505',
  'A reconciliation lease must exclude a concurrent sender');
}

try {
  assert.equal(process.platform, 'win32', 'This smoke uses the authorized Windows PostgreSQL installation');
  await lstat(psql);
  const journal = JSON.parse(await readFile(join(source, 'meta', '_journal.json'), 'utf8')) as Journal;
  assert.equal(journal.entries.length, 20, 'Review this fixture when the migration journal changes');
  assert.equal(journal.entries[19].tag, '0019_rainy_speed_demon');
  assert.equal(journal.entries[18].tag, '0018_amused_thena');
  const temporaryRoot = await realpath(tmpdir());
  temporaryMigrations = await mkdtemp(join(temporaryRoot, 'saas-email-tz-migrations-'));
  const migrationPath = await realpath(temporaryMigrations);
  const relativePath = relative(temporaryRoot, migrationPath);
  assert.ok(relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath), 'Temporary migration folder must stay within the system temporary root');
  await mkdir(join(migrationPath, 'meta'));
  const previous = { ...journal, entries: journal.entries.slice(0, 19) };
  await writeFile(join(migrationPath, 'meta', '_journal.json'), JSON.stringify(previous));
  for (const entry of previous.entries) {
    assert.match(entry.tag, /^\d{4}_[a-zA-Z0-9_-]+$/, 'Only journal SQL basenames can be copied');
    await copyFile(join(source, `${entry.tag}.sql`), join(migrationPath, `${entry.tag}.sql`));
  }

  phase = 'fresh migrations';
  const fresh = await createDatabase(databaseNames[0]);
  await migrate(drizzle(fresh), { migrationsFolder: source });
  await assertSchema(fresh, journal);
  await assertUniqueActiveGuard(fresh);
  const freshHistory = await journalSnapshot(fresh);
  const freshRows = await rowSnapshot(fresh);
  await migrate(drizzle(fresh), { migrationsFolder: source });
  assert.deepEqual(await journalSnapshot(fresh), freshHistory, 'Repeated fresh migration must not alter its journal');
  assert.deepEqual(await rowSnapshot(fresh), freshRows, 'Repeated fresh migration must not alter queue rows');
  console.log('[smoke.email-timezone]', { stage: 'fresh', migrations: 20, timeColumns: 8, activeLeaseGuards: 2, repeat: 'unchanged' });

  phase = 'legacy migration fixture';
  const upgrade = await createDatabase(databaseNames[1]);
  await migrate(drizzle(upgrade), { migrationsFolder: migrationPath });
  assert.equal((await journalSnapshot(upgrade)).length, 19, 'Upgrade must start at the real 0018 schema');
  const baseIso = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  for (const label of labels) {
    const attempts = label === 'unsent' ? 0 : 2;
    const status = label === 'unsent' || label === 'retry' ? 'pending'
      : label === 'dead-letter' ? 'dead_letter' : label;
    await seedLegacyEvent(upgrade, label, attempts, status, baseIso);
  }
  const before = await upgrade<FixtureRow[]>`SELECT e.*, u.name, u.email, u.email_verified,
    u.preferred_locale, u.locale_source, u.marketing_opt_in_requested,
    (extract(epoch FROM e.occurred_at AT TIME ZONE current_setting('TimeZone')) * 1000)::bigint::text AS expected_occurred_ms,
    (extract(epoch FROM e.available_at AT TIME ZONE CASE WHEN e.attempt_count > 0 AND e.status <> 'processing'
      THEN 'UTC' ELSE current_setting('TimeZone') END) * 1000)::bigint::text AS expected_available_ms,
    (extract(epoch FROM e.lease_expires_at AT TIME ZONE current_setting('TimeZone')) * 1000)::bigint::text AS expected_lease_ms,
    (extract(epoch FROM e.created_at AT TIME ZONE current_setting('TimeZone')) * 1000)::bigint::text AS expected_created_ms,
    (extract(epoch FROM e.updated_at AT TIME ZONE current_setting('TimeZone')) * 1000)::bigint::text AS expected_updated_ms
    FROM email_contact_outbox e INNER JOIN "user" u ON u.id = e.user_id ORDER BY e.user_id`;
  assert.equal(before.length, labels.length, 'Only the five synthetic event fixtures are present');
  const priorWire = new Map(before.map((row) => [row.user_id, wire(row)]));
  console.log('[smoke.email-timezone]', { stage: 'legacy', migrations: 19, fixtures: before.length,
    databaseTimeZone: 'Asia/Shanghai', nodeTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });

  phase = 'upgrade to 0019';
  await migrate(drizzle(upgrade), { migrationsFolder: source });
  phase = 'verify upgraded schema';
  await assertSchema(upgrade, journal);
  phase = 'verify legacy timestamps';
  const after = await rowSnapshot(upgrade);
  assert.equal(after.length, before.length, 'Migration cannot add or remove events');
  for (const old of before) {
    const current = after.find((row) => row.user_id === old.user_id)!;
    const label = labels.find((value) => old.user_id.startsWith(`tz-${value}-`))!;
    const previousWire = priorWire.get(old.user_id)!;
    const currentWire = wire(current);
    assert.equal(current.id, old.id, 'Event identity must remain stable');
    assert.equal(current.event_version, old.event_version, 'Event version must remain stable');
    assert.equal(current.status, old.status, 'Migration cannot reschedule event status');
    assert.equal(current.attempt_count, old.attempt_count, 'Migration cannot change attempts');
    assert.equal(currentWire.key, previousWire.key, 'The original operation key must remain stable');
    if (old.attempt_count > 0) {
      assert.equal(currentWire.iso, previousWire.iso,
        `Attempted ${label} wire timestamp changed: ${previousWire.iso} -> ${currentWire.iso}`);
      assert.equal(currentWire.hash, previousWire.hash, `Attempted ${label} request fingerprint must remain stable`);
    } else {
      assert.equal(milliseconds(current.occurred_at), Number(old.expected_occurred_ms), 'Unsent events must retain their actual SQL creation instant');
    }
    assert.equal(milliseconds(current.available_at), Number(old.expected_available_ms), `${label} retry availability must retain its intended instant`);
    assert.equal(current.lease_expires_at === null ? null : milliseconds(current.lease_expires_at), old.expected_lease_ms === null ? null : Number(old.expected_lease_ms),
      `${label} processing lease must retain its intended instant`);
    assert.equal(milliseconds(current.created_at), Number(old.expected_created_ms), `${label} creation instant must remain stable`);
    assert.equal(milliseconds(current.updated_at), Number(old.expected_updated_ms), `${label} update instant must remain stable`);
    assert.equal(milliseconds(current.available_at) - Date.parse(baseIso), 120_000, `${label} availability must remain 120 seconds after the fixture clock`);
    if (label === 'processing') assert.equal(milliseconds(current.lease_expires_at!) - Date.parse(baseIso), 30_000,
      'Processing lease must remain 30 seconds after the fixture clock');
  }
  const upgradeHistory = await journalSnapshot(upgrade);
  await migrate(drizzle(upgrade), { migrationsFolder: source });
  assert.deepEqual(await journalSnapshot(upgrade), upgradeHistory, 'Repeated upgrade must not change the journal');
  assert.deepEqual(await rowSnapshot(upgrade), after, 'Repeated upgrade must not change time or state');
  console.log('[smoke.email-timezone]', { stage: 'upgrade', migrations: 20, fixtures: 5,
    attemptedFingerprintsPreserved: 4, retryDelaySeconds: 120, processingLeaseSeconds: 30, repeat: 'unchanged' });

  phase = 'cross-zone fixture reset';
  const [target] = await upgrade`SELECT current_database() AS database`;
  validateDatabaseName(target.database);
  assert.equal(target.database, databaseNames[1], 'Schema reset is restricted to the owned upgrade database');
  // Reuse this run's disposable upgrade database for a second historical
  // scenario. Neither a third database nor the primary application is touched.
  await upgrade`DROP SCHEMA drizzle CASCADE`;
  await upgrade`DROP SCHEMA public CASCADE`;
  await upgrade`CREATE SCHEMA public`;
  await upgrade.end({ timeout: 5 });
  const crossZone = await connectDatabase(databaseNames[1], 'UTC');
  await migrate(drizzle(crossZone), { migrationsFolder: migrationPath });
  assert.equal((await journalSnapshot(crossZone)).length, 19);
  await seedLegacyEvent(crossZone, 'cross-retry', 2, 'pending', baseIso);
  await seedLegacyEvent(crossZone, 'cross-processing', 2, 'processing', baseIso);
  await seedLegacyEvent(crossZone, 'cross-unsent', 0, 'pending', baseIso);
  // Changing TZ is confined to this fixture process. Capture the same naive
  // values as an actual old UTC Node runner, while PostgreSQL remains in China.
  process.env.TZ = 'UTC';
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC');
  const crossBefore = await rowSnapshot(crossZone);
  const crossWire = new Map(crossBefore.map((row) => [row.user_id, wire(row)]));
  for (const row of crossBefore.filter((value) => value.attempt_count > 0)) {
    assert.equal(Date.parse(crossWire.get(row.user_id)!.iso), Date.parse(baseIso) - 60_000 + 8 * 3_600_000,
      'The cross-zone fixture must observe the old UTC runner interpretation');
  }
  phase = 'cross-zone upgrade';
  await migrate(drizzle(crossZone), { migrationsFolder: source });
  await assertSchema(crossZone, journal);
  const crossAfter = await rowSnapshot(crossZone);
  for (const old of crossBefore) {
    const current = crossAfter.find((row) => row.user_id === old.user_id)!;
    assert.equal(current.id, old.id, 'Cross-zone migration must retain event identity');
    assert.equal(wire(current).key, crossWire.get(old.user_id)!.key, 'Cross-zone migration must retain operation keys');
    if (old.attempt_count > 0) {
      assert.deepEqual(wire(current), crossWire.get(old.user_id), 'An explicit old runner zone must preserve the full wire fingerprint');
    } else {
      assert.equal(milliseconds(current.occurred_at), Date.parse(baseIso) - 60_000,
        'An old runner override must not shift an unsent SQL-created event');
    }
    assert.equal(milliseconds(current.available_at) - Date.parse(baseIso), 120_000,
      'The cross-zone override must not change retry availability');
    if (old.status === 'processing') assert.equal(milliseconds(current.lease_expires_at!) - Date.parse(baseIso), 30_000,
      'The cross-zone override must not change SQL-created leases');
    assert.equal(milliseconds(current.created_at), Date.parse(baseIso) - 180_000,
      'The cross-zone override must not change SQL-created creation timestamps');
    assert.equal(milliseconds(current.updated_at), Date.parse(baseIso),
      'The cross-zone override must not change SQL-created update timestamps');
  }
  const crossHistory = await journalSnapshot(crossZone);
  await migrate(drizzle(crossZone), { migrationsFolder: source });
  assert.deepEqual(await journalSnapshot(crossZone), crossHistory, 'Repeated cross-zone migration must preserve its journal');
  assert.deepEqual(await rowSnapshot(crossZone), crossAfter, 'Repeated cross-zone migration must preserve its events');
  console.log('[smoke.email-timezone]', { stage: 'cross-zone', databaseTimeZone: 'Asia/Shanghai',
    oldRunnerTimeZone: 'UTC', startupOverride: true, attemptedFingerprintsPreserved: 2,
    unsentCreationPreserved: true, retryDelaySeconds: 120, processingLeaseSeconds: 30, repeat: 'unchanged' });
} catch (error) {
  failure = error;
  // Assertion messages contain only fixed text and synthetic dates. Database
  // exceptions can contain connection details/parameters and are never logged.
  console.error('[smoke.email-timezone]', { phase, code: error instanceof AssertionError ? 'ASSERTION_FAILED' : 'FAILED',
    databaseCode: safeFailureCode(error),
    ...(error instanceof TypeError ? { kind: 'TYPE_ERROR',
      ...( /^(Cannot read properties of|Invalid time value)|is not a function$/.test(error.message)
        ? { typeMessage: error.message } : {}),
      location: error.stack?.match(/smoke-email-timezone-migration\.mts:\d+:\d+/)?.[0] } : {}),
    ...(error instanceof AssertionError ? { assertion: error.message.split('\n')[0] } : {}) });
} finally {
  if (originalNodeTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalNodeTimeZone;
  for (const sql of clients) {
    try { await sql.end({ timeout: 5 }); } catch { cleanupFailures++; }
  }
  for (const name of ownedDatabases) {
    try {
      validateDatabaseName(name);
      const actualOwner = admin(`SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = ${literal(name)};`);
      if (!actualOwner) continue;
      assert.equal(actualOwner, owner, 'Only the exact fixture role ownership can be removed');
      admin(`DROP DATABASE ${identifier(name)} WITH (FORCE);`);
      assert.equal(admin(`SELECT count(*) FROM pg_database WHERE datname = ${literal(name)};`), '0', 'Test database must be removed');
    } catch { cleanupFailures++; }
  }
  if (temporaryMigrations) {
    try {
      const target = await realpath(temporaryMigrations);
      const allowedRoot = await realpath(tmpdir());
      const portion = relative(allowedRoot, target);
      assert.ok(portion && !portion.startsWith('..') && !isAbsolute(portion), 'Cleanup must remain under the temporary root');
      assert.ok(basename(target).startsWith('saas-email-tz-migrations-'), 'Only the created fixture folder can be removed');
      assert.equal((await lstat(temporaryMigrations)).isSymbolicLink(), false, 'Never recursively remove a linked cleanup target');
      await rm(target, { recursive: true, force: false });
    } catch { cleanupFailures++; }
  }
  console.log('[smoke.email-timezone]', { stage: 'cleanup', databases: ownedDatabases.size,
    temporaryMigrationFolder: temporaryMigrations ? 1 : 0, failures: cleanupFailures });
  if (failure || cleanupFailures) process.exitCode = 1;
}
