/**
 * `npm run worker`
 *
 * The long-running job process. It owns no business logic: every job is the
 * HTTP entry point the deployment already exposes under /api/internal, guarded
 * by CRON_SECRET through lib/jobs/cron-auth.ts. That keeps one authority for
 * "which job may run" — the same check a scheduler would hit — instead of a
 * second, in-process copy that could drift.
 *
 *   npm run worker                        one pass, every job
 *   npm run worker -- --watch             keep running on an interval
 *   npm run worker -- --kinds=email-sync  only the named jobs
 *   npm run worker -- --once --json       machine-readable pass
 *
 * Point it at the app with APP_BASE_URL (default http://127.0.0.1:3000).
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const jobs = [
  {
    kind: 'email-sync',
    path: '/api/internal/email-center/sync',
    intervalMs: 5_000,
    description: 'Drain the email contact outbox.',
  },
  {
    kind: 'email-reconcile',
    path: '/api/internal/email-center/reconcile',
    intervalMs: 60_000,
    description: 'Reconcile contacts the Email Center already accepted.',
  },
  {
    kind: 'payment-reconcile',
    path: '/api/internal/payment-center/reconcile',
    intervalMs: 30_000,
    description: 'Drain the payment inbox, reconcile commissions, refresh periods.',
  },
  {
    kind: 'referral-sync',
    path: '/api/internal/payment-center/referral-sync',
    intervalMs: 60_000,
    description: 'Push workspace referral profiles to the Payment Center.',
  },
  {
    kind: 'withdrawal-dispatch',
    path: '/api/internal/payment-center/withdrawal-dispatch',
    intervalMs: 15_000,
    description: 'Dispatch leased referral withdrawals.',
  },
];

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    watch: { type: 'boolean', default: false },
    once: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    kinds: { type: 'string' },
    'base-url': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log('Usage: node scripts/worker.mjs [--watch] [--once] [--json] [--kinds=a,b] [--base-url=URL]');
  for (const job of jobs) console.log(`  ${job.kind.padEnd(20)} ${job.description}`);
  process.exit(0);
}

async function loadEnv() {
  try {
    const content = await readFile(new URL('../.env', import.meta.url), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function observation(fields) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...fields });
  if (fields.level === 'error') console.error(line);
  else console.log(line);
}

const requested = values.kinds ? values.kinds.split(',').map((value) => value.trim()).filter(Boolean) : null;
if (requested) {
  const unknown = requested.filter((kind) => !jobs.some((job) => job.kind === kind));
  if (unknown.length) {
    console.error(`Unknown job kind(s): ${unknown.join(', ')}`);
    console.error(`Known kinds: ${jobs.map((job) => job.kind).join(', ')}`);
    process.exit(1);
  }
}
const selected = requested ? jobs.filter((job) => requested.includes(job.kind)) : jobs;
const watch = values.watch && !values.once;

await loadEnv();

const baseUrl = values['base-url'] ?? process.env.APP_BASE_URL ?? 'http://127.0.0.1:3000';
const secret = process.env.CRON_SECRET ?? '';
if (secret.length < 32) {
  console.error('CRON_SECRET is missing or shorter than 32 characters. Run `npm run setup`.');
  process.exit(1);
}

const shutdown = new AbortController();
process.once('SIGINT', () => shutdown.abort());
process.once('SIGTERM', () => shutdown.abort());

async function runJob(job) {
  const startedAt = Date.now();
  try {
    const response = await fetch(new URL(job.path, baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Cache-Control': 'no-store' },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => ({}));
    const ok = response.ok;
    observation({
      event: 'jobs.run',
      module: 'jobs',
      kind: job.kind,
      status: ok ? 'processed' : 'failed',
      level: ok ? 'info' : 'warn',
      code: ok ? 'OK' : `HTTP_${response.status}`,
      detail: ok ? undefined : body.error,
      durationMs: Date.now() - startedAt,
    });
    return { kind: job.kind, ok, status: response.status, report: ok ? body : undefined };
  } catch (error) {
    observation({
      event: 'jobs.run',
      module: 'jobs',
      kind: job.kind,
      status: 'unavailable',
      level: 'error',
      code: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'RUNNER_UNAVAILABLE',
      durationMs: Date.now() - startedAt,
    });
    return { kind: job.kind, ok: false, status: 0 };
  }
}

async function pass() {
  const results = [];
  for (const job of selected) {
    if (shutdown.signal.aborted) break;
    results.push(await runJob(job));
  }
  return results;
}

const first = await pass();
if (values.json) console.log(JSON.stringify({ jobs: first }, null, 2));
if (!watch) {
  const failed = first.filter((result) => !result.ok);
  if (failed.length) {
    console.error(`${failed.length} job(s) failed: ${failed.map((item) => item.kind).join(', ')}`);
    process.exitCode = 1;
  } else {
    observation({ event: 'jobs.run', module: 'jobs', code: 'OK', status: 'processed', count: first.length });
  }
} else {
  // One pass per tick, and the tick is the shortest interval of the selected
  // jobs. A slow job delays the next tick instead of piling up: this process
  // must never hold two leases for the same queue.
  const tick = Math.min(...selected.map((job) => job.intervalMs));
  observation({ event: 'jobs.run', module: 'jobs', code: 'OK', status: 'processed', count: selected.length });
  while (!shutdown.signal.aborted) {
    try {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, tick);
        shutdown.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (shutdown.signal.aborted) break;
      await pass();
    } catch (error) {
      observation({
        event: 'jobs.run', module: 'jobs', level: 'error', status: 'failed',
        code: 'RUNNER_UNAVAILABLE', detail: error?.message,
      });
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
  observation({ event: 'jobs.run', module: 'jobs', code: 'OK', status: 'skipped' });
}
