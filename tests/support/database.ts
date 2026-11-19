import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every test file gets its own PostgreSQL database, cloned from a template that
 * was migrated exactly once.
 *
 * The suite used to share the development database and isolate only by
 * uuid-suffixed fixture ids, which meant two test files running at the same
 * time could see each other's rows (and a crashed run could leave rows behind
 * that broke the next one). Cloning a migrated template costs one file copy
 * instead of a full migration replay, so real isolation is cheap enough to be
 * the default.
 *
 * The local `postgres` administrator authenticates without a password over the
 * loopback interface (see scripts/db-local.ps1); the application role is
 * deliberately not a superuser and cannot create databases.
 */

export const TEST_DB_PREFIX = 'saas_framework_test_';
const TEST_TEMPLATE_DB = 'saas_framework_test_template';

const ADMIN_USER = process.env.TEST_DB_ADMIN_USER ?? 'postgres';

function psqlPath(): string {
  const configured = process.env.TEST_DB_PSQL;
  if (configured) return configured;
  const candidates = [
    'D:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe',
    'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe',
    '/usr/bin/psql',
    '/usr/local/bin/psql',
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      'psql was not found. Set TEST_DB_PSQL to the PostgreSQL client binary so the suite can provision isolated test databases.',
    );
  }
  return found;
}

function applicationUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is missing; run npm run setup first.');
  return url;
}

/** The database the suite was pointed at, i.e. the one it never writes to. */
export function applicationDatabaseName(): string {
  return new URL(applicationUrl()).pathname.replace(/^\//, '');
}

function adminHost(): { host: string; port: string } {
  const url = new URL(applicationUrl());
  return { host: url.hostname, port: url.port || '5432' };
}

/**
 * `psql` is given `-w`, so it never prompts for a password. A local install can
 * fall back to `.pgpass`, but a CI service container cannot — there it fails
 * with `fe_sendauth: no password supplied`, which is what the workflow used to
 * hit the moment lint stopped failing first.
 *
 * The administrator is not always the application role: a local install often
 * keeps `postgres` as the admin and a scoped role in `DATABASE_URL`, and then
 * the URL's password is the wrong secret for `-U postgres`. Pass it only when
 * the URL names that same role — which is exactly how CI is wired
 * (`TEST_DB_ADMIN_USER: saas_framework` over a matching `DATABASE_URL`).
 */
function adminProcessEnv(): NodeJS.ProcessEnv {
  const { username, password } = new URL(applicationUrl());
  if (username !== ADMIN_USER || !password) return process.env;
  return { ...process.env, PGPASSWORD: decodeURIComponent(password) };
}

/** Runs one statement through the administrator connection. `-w` never prompts. */
function adminSql(sql: string): { ok: boolean; stdout: string; stderr: string } {
  const { host, port } = adminHost();
  const result = spawnSync(
    psqlPath(),
    [
      '-h',
      host,
      '-p',
      port,
      '-U',
      ADMIN_USER,
      '-d',
      'postgres',
      '-X',
      '-w',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: adminProcessEnv() },
  );
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Runs a multi-statement psql script against the maintenance database, passing
 * values through `-v` so the script itself stays free of string interpolation.
 */
function runScript(
  script: string,
  variables: Record<string, string>,
): { ok: boolean; stdout: string; stderr: string } {
  const { host, port } = adminHost();
  const file = join(mkdtempSync(join(tmpdir(), 'saas-test-sql-')), 'script.sql');
  writeFileSync(file, script, 'utf8');
  try {
    const result = spawnSync(
      psqlPath(),
      [
        '-h',
        host,
        '-p',
        port,
        '-U',
        ADMIN_USER,
        '-d',
        'postgres',
        '-X',
        '-w',
        '-A',
        '-t',
        ...Object.entries(variables).flatMap(([key, value]) => ['-v', `${key}=${value}`]),
        '-f',
        file,
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: adminProcessEnv() },
    );
    return {
      ok: result.status === 0,
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
    };
  } finally {
    rmSync(file, { force: true });
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function registryPath(): string {
  return join(tmpdir(), 'saas-framework-vitest-databases.json');
}

type RegistryEntry = { database: string; pid: number; at: number };
type Registry = { databases: RegistryEntry[] };

/**
 * Records written by an older version of this file are bare names. They carry no
 * owner, so they are treated as abandoned — the connection check in the reaper
 * still protects any of them that is actually in use.
 */
function toEntry(value: unknown): RegistryEntry | null {
  if (typeof value === 'string') return { database: value, pid: 0, at: 0 };
  if (value && typeof value === 'object') {
    const entry = value as Partial<RegistryEntry>;
    if (typeof entry.database === 'string') {
      return {
        database: entry.database,
        pid: typeof entry.pid === 'number' ? entry.pid : 0,
        at: typeof entry.at === 'number' ? entry.at : 0,
      };
    }
  }
  return null;
}

function readRegistry(): Registry {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(), 'utf8')) as { databases?: unknown };
    if (Array.isArray(parsed.databases)) {
      return {
        databases: parsed.databases
          .map(toEntry)
          .filter((entry): entry is RegistryEntry => entry !== null),
      };
    }
  } catch {
    // A missing or unreadable registry only means nothing is left to clean up.
  }
  return { databases: [] };
}

function writeRegistry(registry: Registry): void {
  writeFileSync(registryPath(), JSON.stringify({ databases: registry.databases }, null, 2), 'utf8');
}

function remember(database: string): void {
  const registry = readRegistry();
  const others = registry.databases.filter((entry) => entry.database !== database);
  // The record names its owner so another process can tell a live sibling from the
  // leftovers of a crashed run without depending on an open connection.
  writeRegistry({ databases: [...others, { database, pid: process.pid, at: Date.now() }] });
}

function forget(database: string): void {
  const registry = readRegistry();
  writeRegistry({
    databases: registry.databases.filter((entry) => entry.database !== database),
  });
}

function dropDatabase(database: string): void {
  const dropped = adminSql(
    `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`,
  );
  if (dropped.ok) forget(database);
}

/**
 * The database this process is currently switched to. Declared before the reaper
 * so a hoisted call can never read it in its temporal dead zone.
 */
let activeDatabase: string | null = null;

/**
 * Creates (or refreshes) the migrated template every file clones from.
 *
 * It runs from `tests/global-setup.ts`, in Vitest's main process, before any
 * worker exists. That placement is the fence: the migration itself cannot live
 * inside the advisory lock below, because it runs as a separate `drizzle-kit`
 * process and the session lock dies the moment psql exits. Two workers used to
 * migrate at once, one of them failed, and its failure path dropped the
 * template out from under the others — which is how a run lost three files to
 * "Migrations failed against the test template database". One process, before
 * the workers start, removes the race instead of narrowing it.
 *
 * The advisory lock still fences `CREATE DATABASE`, where two concurrent
 * callers would otherwise race on `pg_database_datname_index` (the message is
 * localized, so the error code, not the text, is what matters).
 *
 * Two separate test processes started at the same time (a watch run plus a
 * single-file run) can still migrate the template alongside each other: the
 * lock covers the creation only. That case is unmatched, not impossible.
 */
export function ensureTemplate(): void {
  const script = [
    '\\set ON_ERROR_STOP on',
    'SELECT pg_advisory_lock(4917);',
    "SELECT 'CREATE DATABASE ' || quote_ident(:'template') || ' OWNER ' || quote_ident(:'owner') || ' TEMPLATE template0'",
    "WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'template')\\gexec",
    'SELECT pg_advisory_unlock(4917);',
  ].join('\n');

  const bootstrapped = runScript(script, {
    template: TEST_TEMPLATE_DB,
    owner: new URL(applicationUrl()).username,
  });
  if (!bootstrapped.ok) {
    throw new Error(
      `Could not reach the PostgreSQL administrator as "${ADMIN_USER}": ${bootstrapped.stderr}`,
    );
  }

  const migrations = spawnSync(
    process.execPath,
    [join(process.cwd(), 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: withDatabase(applicationUrl(), TEST_TEMPLATE_DB) },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (migrations.status !== 0) {
    adminSql(`DROP DATABASE IF EXISTS ${quoteIdentifier(TEST_TEMPLATE_DB)} WITH (FORCE)`);
    throw new Error(
      `Migrations failed against the test template database:\n${migrations.stdout}\n${migrations.stderr}`,
    );
  }
}

/**
 * How long a record may claim its database before the claim is treated as a
 * recycled process id. It is deliberately far longer than any run: leaking a few
 * empty databases is harmless, dropping one that a live run is using is not.
 */
const REGISTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this one may not signal it.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Drops the databases left behind by an interrupted run so a crashed suite does
 * not accumulate databases forever.
 *
 * It must never touch a database another run is using. The suite has no shared
 * locking between processes — several teammates, or a watch run plus a single
 * file run, are normal — so "starts with the test prefix" is not evidence of
 * abandonment. Ownership is therefore decided by the recorded process id: a
 * database whose owner is still running belongs to a live run. Checking an open
 * connection instead was not enough, because a worker between two statements
 * holds none: `npm test` failed with `PostgresError: database
 * "saas_framework_test_pool_3_<hash>" does not exist` when a sibling worker
 * provisioned its own database during that window. A connection check is still
 * applied as a second guard before anything is dropped.
 */
export function reapOrphanedTestDatabases(): void {
  const now = Date.now();
  const candidates = readRegistry().databases
    .filter((entry) => entry.database.startsWith(TEST_DB_PREFIX))
    .filter((entry) => entry.database !== activeDatabase)
    .filter((entry) => now - entry.at > REGISTRY_MAX_AGE_MS || !processIsAlive(entry.pid));
  if (candidates.length === 0) return;

  const quoted = candidates.map((entry) => quoteIdentifier(entry.database)).join(', ');
  const busy = adminSql(
    `SELECT DISTINCT datname FROM pg_stat_activity WHERE datname IN (${quoted})`,
  );
  const inUse = new Set(
    busy.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
  );

  for (const entry of candidates) {
    if (inUse.has(entry.database)) continue;
    dropDatabase(entry.database);
  }
}

/**
 * Switches this process onto a private, migrated, empty database and returns
 * its connection URL. It must run before any module that reads DATABASE_URL at
 * import time, which is why the loader is a Vitest setupFile.
 *
 * The template it clones is migrated once by `tests/global-setup.ts`, before
 * this process exists; migrating it here as well is what used to make four
 * workers collide (see `ensureTemplate`).
 */
export function provisionTestDatabase(label: string): string {
  reapOrphanedTestDatabases();

  const safeLabel = label
    .replace(TEST_DB_PREFIX, '')
    .replace(/[^a-z0-9]/gi, '_')
    .toLowerCase()
    .slice(0, 28);
  const database = `${TEST_DB_PREFIX}${safeLabel}_${randomBytes(4).toString('hex')}`;
  const owner = new URL(applicationUrl()).username;
  const created = adminSql(
    `CREATE DATABASE ${quoteIdentifier(database)} OWNER ${quoteIdentifier(
      owner,
    )} TEMPLATE ${quoteIdentifier(TEST_TEMPLATE_DB)}`,
  );
  if (!created.ok) throw new Error(`Could not create ${database}: ${created.stderr}`);

  remember(database);
  activeDatabase = database;
  return withDatabase(applicationUrl(), database);
}

export function dropIsolatedDatabase(): void {
  if (!activeDatabase) return;
  const database = activeDatabase;
  activeDatabase = null;
  dropDatabase(database);
}
