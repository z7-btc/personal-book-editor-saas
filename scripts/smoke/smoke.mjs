/**
 * `npm run smoke`
 *
 * Runs the offline smoke scripts — the ones that talk only to the local
 * database and to in-process stubs — sequentially, and stops at the first
 * failure. `npm test` proves the library contracts; this proves the operator
 * paths a human actually types still work end to end.
 *
 * Scripts that need a running app, a live Payment Center, a live Email Center or
 * a real chain are listed under `live` and are never started implicitly: the
 * plan requires that a missing third-party credential is reported as blocked
 * rather than turned into a fabricated success.
 *
 *   npm run smoke                        every offline suite
 *   npm run smoke -- --suite=referral    only the matching suites
 *   npm run smoke -- --list              names and tags, run nothing
 *   npm run smoke -- --live=payment-center-live   an explicitly requested live suite
 *
 * Exit code 2 from a suite means "blocked": a precondition is missing (another
 * dev server holds the project, the database is not empty, a queue is busy), so
 * nothing was verified. The runner reports those by name and does not count
 * them as passed.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

const suites = [
  { name: 'referral-sync', runner: 'tsx', tags: ['referral', 'database'] },
  { name: 'email-sync', runner: 'tsx', tags: ['email', 'database'] },
  { name: 'withdrawal-crypto', runner: 'conditions', tags: ['referral', 'crypto'] },
  { name: 'withdrawal-intent', runner: 'conditions', tags: ['referral', 'database'] },
  { name: 'payment-catalog', runner: 'conditions', tags: ['billing'] },
  { name: 'billing-account', runner: 'conditions', tags: ['billing', 'database'] },
  { name: 'payment-intent', runner: 'conditions', tags: ['billing', 'database'] },
  { name: 'payment-submit', runner: 'conditions', tags: ['billing', 'database'] },
  { name: 'payment-order-contract', runner: 'conditions', tags: ['billing'] },
  { name: 'payment-subscription-contract', runner: 'conditions', tags: ['billing'] },
  { name: 'payment-webhook', runner: 'conditions', tags: ['billing', 'database'] },
  { name: 'subscription-grants', runner: 'conditions', tags: ['billing', 'database'] },
  { name: 'prepaid-grants', runner: 'conditions', tags: ['billing', 'database'] },
  { name: 'payment-inbox', runner: 'conditions', tags: ['billing', 'database'] },
  { name: 'billing-controls', runner: 'tsx', tags: ['billing', 'database'] },
  { name: 'activity-boundaries', runner: 'conditions', tags: ['activity'] },
];

// Never run implicitly: each one needs a live service, a credential or a chain.
// `runner`/`file` mirror the matching `smoke:*` npm script, because a suite that
// imports a `server-only` module needs the react-server condition to load at all.
const live = [
  { name: 'payment-center-live', runner: 'conditions', reason: 'needs a running Payment Center on PAYMENT_CENTER_BASE_URL' },
  { name: 'email-center-live', reason: 'needs a running Email Center on EMAIL_CENTER_URL' },
  { name: 'referral-live', reason: 'needs the Payment Center referral binding' },
  { name: 'referral-binding-live', reason: 'needs the Payment Center referral binding' },
  { name: 'payment-binding-live', runner: 'conditions', reason: 'needs the Payment Center site binding' },
  { name: 'email-reconcile-live', reason: 'needs the Email Center reconciliation endpoint' },
  { name: 'email-verification-live', reason: 'needs the dev server and a mailbox' },
  { name: 'password-reset-live', reason: 'needs the dev server and a mailbox' },
  { name: 'account-settings-live', reason: 'needs the dev server' },
  { name: 'withdrawal-http', reason: 'needs the dev server' },
  { name: 'auth', runner: 'node', file: 'scripts/smoke-auth.mjs', reason: 'needs the dev server and the Turnstile test keys' },
];

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const inline = argv.find((value) => value.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node scripts/smoke.mjs [--suite=NAME] [--live=NAME] [--list] [--concurrency=1]');
  console.log('');
  console.log('Offline suites (default):');
  for (const suite of suites) console.log(`  ${suite.name.padEnd(32)} ${suite.tags.join(', ')}`);
  console.log('');
  console.log('Live suites (opt in with --live=NAME):');
  for (const suite of live) console.log(`  ${suite.name.padEnd(32)} ${suite.reason}`);
  process.exit(0);
}

if (argv.includes('--list')) {
  console.log(JSON.stringify({ offline: suites.map((suite) => suite.name), live: live.map((suite) => suite.name) }, null, 2));
  process.exit(0);
}

const filter = valueOf('--suite');
const selected = filter
  ? suites.filter((suite) => suite.name.includes(filter) || suite.tags.includes(filter))
  : suites;

const requestedLive = argv
  .filter((value) => value.startsWith('--live='))
  .map((value) => value.slice('--live='.length));
const unknownLive = requestedLive.filter((name) => !live.some((suite) => suite.name === name));
if (unknownLive.length) {
  console.error(`Unknown live suite(s): ${unknownLive.join(', ')}`);
  process.exit(1);
}

if (!selected.length && !requestedLive.length) {
  console.error(`No suite matches --suite=${filter}`);
  process.exit(1);
}

/** Every script is re-armed with its own `--env-file=.env` so it cannot read a stale shell value. */
function commandFor(name, runner, file) {
  const script = file ?? `scripts/smoke-${name}.mts`;
  if (runner === 'node') return { command: process.execPath, args: [script] };
  const args = runner === 'conditions'
    ? ['--conditions=react-server', '--import', 'tsx', '--env-file=.env', script]
    : ['--import', 'tsx', '--env-file=.env', script];
  return { command: process.execPath, args };
}

function run(name, runner, file) {
  const { command, args } = commandFor(name, runner, file);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: 'inherit' });
    child.on('close', (code) => resolve({ name, code: code ?? 1 }));
    child.on('error', (error) => {
      console.error(`${name}: ${error.message}`);
      resolve({ name, code: 1 });
    });
  });
}

async function envHas(name) {
  try {
    const content = await readFile(join(projectRoot, '.env'), 'utf8');
    return new RegExp(`^${name}=.+$`, 'm').test(content);
  } catch {
    return false;
  }
}

console.log(`Running ${selected.length} offline smoke suite(s) sequentially.`);
const failures = [];
const blocked = [];
for (const suite of selected) {
  console.log('');
  console.log(`--- smoke:${suite.name} (${suite.tags.join(', ')}) ---`);
  const result = await run(suite.name, suite.runner, suite.file);
  if (result.code === 2) blocked.push(suite.name);
  else if (result.code !== 0) failures.push(suite.name);
}

for (const name of requestedLive) {
  const spec = live.find((suite) => suite.name === name);
  console.log('');
  console.log(`--- smoke:${name} (live: ${spec.reason}) ---`);
  const result = await run(name, spec.runner, spec.file);
  if (result.code === 2) blocked.push(name);
  else if (result.code !== 0) failures.push(name);
}

for (const spec of live) {
  if (!requestedLive.includes(spec.name)) {
    console.log(`skipped live suite: ${spec.name} (${spec.reason})`);
  }
}
if (!(await envHas('CRON_SECRET'))) {
  console.log('note: CRON_SECRET is not set in .env; worker smoke checks will report it as blocked.');
}

console.log('');
if (blocked.length) {
  console.log(`Blocked smoke suite(s) — precondition missing, nothing verified: ${blocked.join(', ')}`);
}
if (failures.length) {
  console.error(`Smoke failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`Smoke passed: ${selected.length + requestedLive.length - blocked.length} suite(s)${
  blocked.length ? `, ${blocked.length} blocked` : ''
}.`);
