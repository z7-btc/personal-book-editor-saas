/**
 * `npm run seed`
 *
 * The plan keeps every catalog item, price and referral rule inside the Payment
 * Center — this application owns no seedable configuration table. What it does
 * own is a set of tables that must exist and a capability matrix that must be
 * coherent before the app can be started. So `seed` is a verifier, not a
 * content writer: it proves the database build is complete and prints what the
 * deployment has switched on.
 *
 * It deliberately writes nothing. Fabricating a user, a workspace or a paid
 * period here would create the exact synthetic data the plan forbids ("不伪造
 * 三项目联调、支付、邮件或部署验证成功"), and it would break the attribution
 * invariants that PostgreSQL enforces.
 *
 *   npm run seed            report
 *   npm run seed -- --check exit 1 when the build is incomplete (CI gate)
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This file lives in `scripts/`, so a bare `postgres` specifier would resolve
// against `scripts/node_modules`. Resolve from the project root, where
// package.json actually declares it.
const projectRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
const postgres = (await import(
  pathToFileURL(createRequire(join(projectRoot, 'package.json')).resolve('postgres')).href
)).default;

const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const json = args.has('--json');
if (args.has('--help') || args.has('-h')) {
  console.log('Usage: node scripts/seed.mjs [--check] [--json]');
  process.exit(0);
}

/**
 * Minimal .env reader. `process.loadEnvFile` would be tidier but it does not
 * exist on every Node this project supports, and the values must not be echoed.
 */
async function loadEnv() {
  let content;
  try {
    content = await readFile(new URL('../.env', import.meta.url), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
  return true;
}

/** Tables this application creates and reads. Anything missing is a broken build. */
const requiredTables = [
  'user', 'session', 'account', 'member', 'organization', 'rateLimit',
  'billing_accounts', 'payment_intents', 'payment_evidence', 'payment_inbox',
  'payment_handshake_challenges', 'subscription_grants', 'subscriptions',
  'commission_grant_preparations', 'referral_profiles', 'referral_attributions',
  'referral_user_outbox', 'referral_withdrawal_intents', 'email_contact_outbox',
  'account_activity',
];

const featureFlags = [
  'FEATURE_TURNSTILE', 'FEATURE_GOOGLE_OAUTH', 'FEATURE_GITHUB_OAUTH',
  'FEATURE_PAYMENT_CENTER', 'FEATURE_REFERRALS', 'FEATURE_EMAIL_CENTER',
  'FEATURE_EMAIL_CENTER_WIDGET', 'FEATURE_TRANSACTIONAL_EMAIL',
];

function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error('DATABASE_URL is not set. Run `npm run setup` first.');
  }
  const url = new URL(value);
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new Error('DATABASE_URL must be a postgres:// URL.');
  }
  if (url.password.includes('@') || url.password.includes('/') || url.password.includes('#')) {
    throw new Error(
      'The password in DATABASE_URL contains a reserved character. Percent-encode it '
      + '(for example @ becomes %40) so the connection string stays unambiguous.',
    );
  }
  return url;
}

async function main() {
  const envExists = await loadEnv();
  const url = databaseUrl();
  const sql = postgres(url.toString(), { max: 1, connect_timeout: 10 });

  try {
    const [{ version }] = await sql`SELECT version() AS version`;
    const [{ zone }] = await sql`SELECT current_setting('TimeZone') AS zone`;
    const rows = await sql`
      SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
    `;
    const present = new Set(rows.map((row) => row.table_name));
    const missing = requiredTables.filter((name) => !present.has(name));

    // drizzle-kit records its journal in the `drizzle` schema, not in `public`.
    const journal = rows.some(
      (row) => row.table_schema === 'drizzle' && row.table_name === '__drizzle_migrations',
    );
    const migrations = journal
      ? await sql`SELECT count(*)::integer AS applied FROM drizzle.__drizzle_migrations`
      : [{ applied: 0 }];
    const capabilities = Object.fromEntries(featureFlags.map((name) => [
      name,
      process.env[name] === 'true',
    ]));
    const catalogLive = capabilities.FEATURE_PAYMENT_CENTER
      && Boolean(process.env.PAYMENT_CENTER_URL && process.env.PAYMENT_CENTER_SITE_CODE);

    const report = {
      envFile: envExists ? 'present' : 'missing',
      database: { reachable: true, server: String(version).split(' ').slice(0, 2).join(' '), timeZone: zone },
      schema: {
        required: requiredTables.length,
        present: requiredTables.length - missing.length,
        missing,
        migrationsApplied: Number(migrations[0]?.applied ?? 0),
      },
      capabilities,
      notes: [
        'The product catalog and its prices live in the Payment Center, so this project seeds no catalog rows.',
        catalogLive
          ? 'FEATURE_PAYMENT_CENTER is on; check the catalog with `npm run smoke:payment-catalog`.'
          : 'FEATURE_PAYMENT_CENTER is off; the billing surface stays hidden and no checkout can start.',
        'Test data belongs to the test suite (tests/support/fixtures.ts), not to this script.',
      ],
    };

    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`.env: ${report.envFile}`);
      console.log(`database: reachable (${report.database.server}, TimeZone ${report.database.timeZone})`);
      console.log(`schema: ${report.schema.present}/${report.schema.required} required tables, `
        + `${report.schema.migrationsApplied} migrations recorded`);
      if (missing.length) console.log(`missing: ${missing.join(', ')}`);
      for (const [name, enabled] of Object.entries(capabilities)) {
        console.log(`  ${enabled ? 'on ' : 'off'} ${name}`);
      }
      for (const note of report.notes) console.log(`note: ${note}`);
    }

    if (missing.length) {
      console.log('');
      console.log('The database build is incomplete. Apply it with:');
      console.log('  npm run db:local:up && npm run db:migrate');
      if (check) process.exitCode = 1;
      return;
    }
    console.log('');
    console.log('Seed check passed. Nothing was written.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
