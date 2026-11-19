import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanupFixtures,
  closeClient,
  getClient,
  scopedId,
  type FixtureScope,
} from './support/fixtures';

/**
 * Job runners (plan acceptance criteria 6, 27 and 37).
 *
 * Everything here goes through the real modules: the cron guard, the exported
 * route handlers the platform scheduler will call, the retention scrub against
 * the real PostgreSQL instance, and the npm scripts/docs that decide which
 * runner exists on which platform. The only values swapped out are environment
 * variables, and every swap is undone in `afterEach`.
 */

// lib/config.ts snapshots the `features` object when it is first evaluated, so
// the capability this file exercises has to be on before any import happens.
process.env.FEATURE_EMAIL_CENTER = 'true';

const repoRoot = process.cwd();
const readFile = (relativePath: string) => readFileSync(join(repoRoot, relativePath), 'utf8');
const readJson = (relativePath: string) => JSON.parse(readFile(relativePath)) as Record<string, unknown>;
const scripts = () => readJson('package.json').scripts as Record<string, string>;

const SYNC_URL = 'http://localhost:3000/api/internal/email-center/sync';
const RECONCILE_URL = 'http://localhost:3000/api/internal/email-center/reconcile';
const EMAIL_CENTER_ROUTES = [
  'app/api/internal/email-center/sync/route.ts',
  'app/api/internal/email-center/reconcile/route.ts',
];
/** Every scheduler entry point, with the contract its file declares. */
const INTERNAL_ROUTES: Array<{
  file: string;
  maxDuration: number | null;
  methods: Array<'GET' | 'POST'>;
  sharedHandler: boolean;
}> = [
  { file: EMAIL_CENTER_ROUTES[0], maxDuration: 30, methods: ['GET', 'POST'], sharedHandler: true },
  { file: EMAIL_CENTER_ROUTES[1], maxDuration: 30, methods: ['GET', 'POST'], sharedHandler: true },
  {
    file: 'app/api/internal/payment-center/reconcile/route.ts',
    maxDuration: 60, methods: ['GET', 'POST'], sharedHandler: true,
  },
  {
    file: 'app/api/internal/payment-center/referral-sync/route.ts',
    maxDuration: 30, methods: ['GET', 'POST'], sharedHandler: true,
  },
  {
    file: 'app/api/internal/payment-center/withdrawal-dispatch/route.ts',
    maxDuration: null, methods: ['GET'], sharedHandler: false,
  },
];

let cronAuth: typeof import('@/lib/jobs/cron-auth');
let syncRoute: typeof import('@/app/api/internal/email-center/sync/route');
let reconcileRoute: typeof import('@/app/api/internal/email-center/reconcile/route');
let maintenance: typeof import('@/lib/jobs/maintenance');

const scope: FixtureScope = { userIds: [] };
/** Every row this file inserts, so `afterAll` can prove the tables come back clean. */
const inboxEventIds: string[] = [];
const challengeIds: string[] = [];

beforeAll(async () => {
  [cronAuth, syncRoute, reconcileRoute, maintenance] = await Promise.all([
    import('@/lib/jobs/cron-auth'),
    import('@/app/api/internal/email-center/sync/route'),
    import('@/app/api/internal/email-center/reconcile/route'),
    import('@/lib/jobs/maintenance'),
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  const client = await getClient();
  if (inboxEventIds.length > 0) {
    await client`DELETE FROM payment_inbox WHERE event_id = ANY(${inboxEventIds})`;
  }
  if (challengeIds.length > 0) {
    await client`DELETE FROM payment_handshake_challenges WHERE check_id = ANY(${challengeIds})`;
  }
  await cleanupFixtures(scope);
  await closeClient();
});

function authedRequest(url: string, secret: string): Request {
  return new Request(url, { headers: { authorization: `Bearer ${secret}` } });
}

function plainRequest(url: string): Request {
  return new Request(url);
}

const body = async (response: Response) => await response.json() as Record<string, unknown>;

/** Runs one route handler with cron mode enabled and a long, valid secret. */
async function callRunner(
  handler: (request: Request) => Promise<Response>,
  url: string,
  secret = 'vitest-cron-secret-0123456789abcdefghij',
): Promise<Response> {
  vi.stubEnv('RECOVERY_RUNNER_MODE', 'cron');
  vi.stubEnv('CRON_SECRET', secret);
  return await handler(authedRequest(url, secret));
}

describe('cron authentication', () => {
  it('keeps the runner disabled in the local manual mode, even for a caller with the secret', async () => {
    vi.stubEnv('RECOVERY_RUNNER_MODE', 'manual');
    vi.stubEnv('CRON_SECRET', 'vitest-cron-secret-0123456789abcdefghij');

    const failure = cronAuth.cronFailure(authedRequest(SYNC_URL, 'vitest-cron-secret-0123456789abcdefghij'));

    expect(failure?.status).toBe(503);
    expect(await body(failure!)).toEqual({ error: 'runner_disabled' });
    expect(failure!.headers.get('cache-control')).toBe('no-store');
  });

  it('fails closed in cron mode when the secret is missing or shorter than 32 characters', async () => {
    vi.stubEnv('RECOVERY_RUNNER_MODE', 'cron');
    vi.stubEnv('CRON_SECRET', '');
    const absent = cronAuth.cronFailure(authedRequest(SYNC_URL, 'vitest-cron-secret-0123456789abcdefghij'));
    expect(absent?.status).toBe(503);
    expect(await body(absent!)).toEqual({ error: 'runner_unconfigured' });

    vi.stubEnv('CRON_SECRET', 'x'.repeat(31));
    const short = cronAuth.cronFailure(authedRequest(SYNC_URL, 'x'.repeat(31)));
    expect(short?.status).toBe(503);
    expect(await body(short!)).toEqual({ error: 'runner_unconfigured' });

    // A 32-character secret is the documented minimum and must already work.
    const exact = 'y'.repeat(32);
    vi.stubEnv('CRON_SECRET', exact);
    expect(cronAuth.cronFailure(authedRequest(SYNC_URL, exact))).toBeNull();
  });

  it('rejects a missing, unnamed or malformed Authorization header', async () => {
    vi.stubEnv('RECOVERY_RUNNER_MODE', 'cron');
    const secret = 'vitest-cron-secret-0123456789abcdefghij';
    vi.stubEnv('CRON_SECRET', secret);

    const cases: Array<[string, Request]> = [
      ['no header', plainRequest(SYNC_URL)],
      ['wrong scheme', new Request(SYNC_URL, { headers: { authorization: `Basic ${secret}` } })],
      ['scheme without a space', new Request(SYNC_URL, { headers: { authorization: 'Bearer' } })],
      ['lowercase scheme', new Request(SYNC_URL, { headers: { authorization: `bearer ${secret}` } })],
      ['secret without a scheme', new Request(SYNC_URL, { headers: { authorization: secret } })],
    ];

    for (const [label, request] of cases) {
      const failure = cronAuth.cronFailure(request);
      expect(failure?.status, label).toBe(401);
      expect(await body(failure!), label).toEqual({ error: 'unauthorized' });
      expect(failure!.headers.get('cache-control'), label).toBe('no-store');
    }
  });

  it('compares the whole secret: a near miss is rejected', async () => {
    vi.stubEnv('RECOVERY_RUNNER_MODE', 'cron');
    const secret = 'vitest-cron-secret-0123456789abcdefghij';
    vi.stubEnv('CRON_SECRET', secret);

    const nearMisses = [
      `${secret.slice(0, -1)}k`, // differs in the final character only
      secret.slice(0, -1), // a correct prefix is not enough
      `${secret}x`, // a correct secret plus trailing noise
    ];

    for (const candidate of nearMisses) {
      const failure = cronAuth.cronFailure(authedRequest(SYNC_URL, candidate));
      expect(failure?.status, candidate).toBe(401);
    }
    expect(cronAuth.cronFailure(authedRequest(SYNC_URL, secret))).toBeNull();
  });

  it('rejects an oversized Authorization header before comparing anything', async () => {
    vi.stubEnv('RECOVERY_RUNNER_MODE', 'cron');
    vi.stubEnv('CRON_SECRET', 'vitest-cron-secret-0123456789abcdefghij');

    const failure = cronAuth.cronFailure(authedRequest(SYNC_URL, 'z'.repeat(1_100)));

    expect(failure?.status).toBe(401);
    expect(await body(failure!)).toEqual({ error: 'unauthorized' });
  });

  it('authenticates the secret that is actually configured for this environment', async () => {
    const configured = process.env.CRON_SECRET ?? '';
    expect(configured.length, 'the local environment must carry the generated CRON_SECRET').toBeGreaterThanOrEqual(32);

    vi.stubEnv('RECOVERY_RUNNER_MODE', 'cron');
    expect(cronAuth.cronFailure(authedRequest(SYNC_URL, configured))).toBeNull();

    const response = await syncRoute.GET(authedRequest(SYNC_URL, configured));
    expect(response.status).toBe(200);
  });
});

describe('internal runner endpoints', () => {
  it('serves GET and POST from one guarded handler per endpoint', () => {
    expect(syncRoute.GET).toBe(syncRoute.POST);
    expect(reconcileRoute.GET).toBe(reconcileRoute.POST);
    expect(syncRoute.runtime).toBe('nodejs');
    expect(syncRoute.dynamic).toBe('force-dynamic');
    expect(syncRoute.maxDuration).toBe(30);
    expect(reconcileRoute.runtime).toBe('nodejs');
    expect(reconcileRoute.dynamic).toBe('force-dynamic');
    expect(reconcileRoute.maxDuration).toBe(30);
  });

  it('guards every internal runner route with the same cron check', () => {
    for (const { file: route, maxDuration, methods, sharedHandler } of INTERNAL_ROUTES) {
      const source = readFile(route);
      // The check must run before any queue work, and every answer must be no-store.
      expect(source, route).toContain('cronFailure(request)');
      expect(source, route).toContain('cronHeaders');
      expect(source, route).toContain("export const runtime = 'nodejs';");
      expect(source, route).toContain("export const dynamic = 'force-dynamic';");
      for (const method of methods) {
        expect(source, `${route} ${method}`).toMatch(
          new RegExp(`export (async function ${method}\\(request: Request\\)|const ${method} = handle;)`),
        );
      }
      if (sharedHandler) {
        expect(source, route).toMatch(/export const GET = handle;/);
        expect(source, route).toMatch(/export const POST = handle;/);
      }
      if (maxDuration === null) {
        expect(source, route).not.toContain('export const maxDuration');
      } else {
        expect(source, route).toContain(`export const maxDuration = ${maxDuration};`);
      }
    }
  });

  it('answers an authorised sync with a no-store 200 and repeats itself safely', async () => {
    const first = await callRunner(syncRoute.GET, SYNC_URL);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const firstBody = await body(first);
    expect(firstBody.status).toBe('ok');
    expect(firstBody.report).toMatchObject({
      claimed: 0, succeeded: 0, reconciled: 0, retried: 0, deadLetter: 0, superseded: 0,
    });

    const posted = await callRunner(syncRoute.POST, SYNC_URL);
    expect(posted.status).toBe(200);
    expect(await body(posted)).toEqual(firstBody);

    const second = await callRunner(syncRoute.GET, SYNC_URL);
    expect(second.status).toBe(200);
    expect(await body(second)).toEqual(firstBody);
  });

  it('answers an authorised reconcile with a no-store 200 and repeats itself safely', async () => {
    const first = await callRunner(reconcileRoute.GET, RECONCILE_URL);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const firstBody = await body(first);
    expect(firstBody.status).toBe('ok');
    expect(firstBody.report).toMatchObject({
      checked: 0, confirmed: 0, notReceived: 0, conflicts: 0, unreachable: 0, superseded: 0,
    });

    const second = await callRunner(reconcileRoute.POST, RECONCILE_URL);
    expect(second.status).toBe(200);
    expect(await body(second)).toEqual(firstBody);
  });

  it('turns an incomplete Email Center configuration into 503 sync_unavailable, not a crash', async () => {
    vi.stubEnv('RECOVERY_RUNNER_MODE', 'cron');
    const secret = 'vitest-cron-secret-0123456789abcdefghij';
    vi.stubEnv('CRON_SECRET', secret);
    // requireCapability reads the environment at call time, so the runner can be
    // starved of its key without reloading modules.
    vi.stubEnv('EMAIL_CENTER_API_KEY', '');

    const response = await syncRoute.GET(authedRequest(SYNC_URL, secret));

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await body(response)).toEqual({ error: 'sync_unavailable' });
  });

  it('turns an incomplete Email Center configuration into 503 reconcile_unavailable', async () => {
    vi.stubEnv('RECOVERY_RUNNER_MODE', 'cron');
    const secret = 'vitest-cron-secret-0123456789abcdefghij';
    vi.stubEnv('CRON_SECRET', secret);
    vi.stubEnv('EMAIL_CENTER_URL', '');

    const response = await reconcileRoute.GET(authedRequest(RECONCILE_URL, secret));

    expect(response.status).toBe(503);
    expect(await body(response)).toEqual({ error: 'reconcile_unavailable' });
  });

  it('refuses an unauthenticated call before it touches the queue', async () => {
    vi.stubEnv('RECOVERY_RUNNER_MODE', 'cron');
    vi.stubEnv('CRON_SECRET', 'vitest-cron-secret-0123456789abcdefghij');

    const response = await syncRoute.POST(authedRequest(SYNC_URL, 'vitest-cron-secret-wrong-0123456789abcdef'));

    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: 'unauthorized' });
  });
});

describe('runner mode and schedules', () => {
  it('keeps npm run dev and npm run start to a single command', () => {
    const defined = scripts();
    expect(defined.dev).toBe('next dev');
    expect(defined.start).toBe('next start');
    for (const name of ['dev', 'start']) {
      expect(defined[name], `${name} must not chain a job runner into the server`).not.toMatch(
        /(email:loop|email:sync|worker|referral:sync|withdrawal:dispatch|maintenance|concurrently|&&|\s&\s)/,
      );
    }
    // The queues drain from inside the server itself (see
    // lib/jobs/background.ts), which is why these stay single commands: the
    // standalone worker is still there for deployments that prefer it, but
    // nobody has to remember to start it.
    expect(Object.values(defined).filter((command) => command.includes('scripts/ops/worker.mjs'))).toHaveLength(1);
  });

  it('keeps every recovery runner as an explicit, separately invokable script', () => {
    const defined = scripts();
    expect(defined.worker).toMatch(/scripts\/ops\/worker\.mjs/);
    expect(defined['email:loop']).toBe('tsx scripts/ops/email-sync-loop.mts');
    for (const name of ['email:sync', 'email:reconcile', 'referral:sync', 'withdrawal:dispatch', 'payment:reconcile']) {
      expect(defined[name], name).toBeTruthy();
      expect(defined[name], name).toMatch(/(tsx|node --conditions=react-server --import tsx) scripts\//);
    }
    // Acceptance criterion 37: the local checks are the only entry points.
    expect(defined.test).toBe('vitest run');
    expect(defined.typecheck).toBe('tsc --noEmit');
    expect(defined.lint).toBe('eslint .');
    expect(defined.build).toBe('next build');
    expect(defined.maintenance).toMatch(/scripts\/ops\/maintenance\.mjs/);
    expect(defined['test:e2e']).toMatch(/playwright test/);
  });

  it('offers the retention scrub as a manual, previewable script', () => {
    const maintenanceScript = readFile('scripts/ops/maintenance.mjs');
    // The scripts live one level down now, so their relative imports reach one
    // level further up.
    expect(maintenanceScript).toContain("import('../../lib/jobs/maintenance.ts')");
    expect(maintenanceScript).toContain('runMaintenance');
    expect(maintenanceScript).toContain('--dry-run'); // preview before touching data
    expect(maintenanceScript).toContain('--json');
  });

  it('polls the same guarded endpoints from the resident worker', () => {
    const worker = readFile('scripts/ops/worker.mjs');
    expect(worker).toContain('/api/internal/email-center/sync');
    expect(worker).toContain('/api/internal/email-center/reconcile');
    expect(worker).toContain('CRON_SECRET'); // one authority for "which job may run"
    const intervals = [...worker.matchAll(/intervalMs:\s*([\d_]+)/g)].map((match) => Number(match[1].replace(/_/g, '')));
    expect(intervals.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...intervals)).toBeLessThanOrEqual(10_000);
  });

  it('runs the same library code from the CLI scripts and from the HTTP routes', () => {
    const sync = readFile('scripts/ops/sync-email-center.mts');
    const reconcile = readFile('scripts/ops/reconcile-email-center.mts');
    // The scripts load the database only after dotenv has run, so the imports are dynamic.
    expect(sync).toContain("import('../../lib/email-center/worker')");
    expect(sync).toContain('runEmailContactSync');
    expect(reconcile).toContain("import('../../lib/email-center/reconcile')");
    expect(reconcile).toContain('runEmailContactReconcile');
    expect(readFile(EMAIL_CENTER_ROUTES[0])).toContain('runEmailContactSync');
    expect(readFile(EMAIL_CENTER_ROUTES[1])).toContain('runEmailContactReconcile');
  });

  it('drains a backlog immediately and never idles longer than ten seconds', () => {
    const loop = readFile('scripts/ops/email-sync-loop.mts');
    const pauses = [...loop.matchAll(/pause\((\d[\d_]*)\)/g)].map((match) => Number(match[1].replace(/_/g, '')));
    expect(pauses.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...pauses)).toBeLessThanOrEqual(10_000); // the idle cadence the plan allows
    expect(loop).toMatch(/if \(!report\.claimed\) await pause\(/); // never sleeps while work is left
    expect(loop).toContain('runEmailContactReconcile');
    expect(loop).toMatch(/SIGTERM/); // a scheduled platform can stop it cleanly
  });

  it('documents the manual default and every supported platform', () => {
    const doc = readFile('docs/recovery-runners.md');
    expect(doc).toContain('RECOVERY_RUNNER_MODE=manual');
    expect(doc).toMatch(/npm run dev/);
    expect(doc).toMatch(/10[- ]second/);
    expect(doc).toContain('CRON_SECRET');
    for (const platform of ['Docker', 'Zeabur', 'Vercel']) {
      expect(doc, platform).toContain(platform);
    }
  });

  it('documents the retention windows in the environment contract', () => {
    const example = readFile('.env.example');
    expect(example).toMatch(/COMPLETED_PAYLOAD_RETENTION_DAYS=30/);
    expect(example).toMatch(/FAILED_PAYLOAD_RETENTION_DAYS=90/);
    expect(example).toMatch(/AUDIT_RETENTION_DAYS=365/);
    // `.env` is the developer's private file; CI checks out the repository
    // without one, so only a checkout that has it can assert what it holds.
    if (existsSync(join(repoRoot, '.env'))) {
      const env = readFile('.env');
      expect(env).toMatch(/RECOVERY_RUNNER_MODE=manual/); // the local default stays manual
    }
  });

  it('keeps optional GitHub Actions limited to the same npm scripts', () => {
    const directory = join(repoRoot, '.github', 'workflows');
    // Continuous integration is explicitly optional in the plan; when it exists it
    // must call the local scripts rather than reimplement the checks.
    if (!existsSync(directory)) return;
    const commands: string[] = [];
    for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
      const lines = readFile(join('.github', 'workflows', file)).split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const match = /^(\s*)run:\s*(.*)$/.exec(lines[index]);
        if (!match) continue;
        const [, indent, value] = match;
        if (/^[|>]/.test(value)) {
          for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
            const line = lines[cursor];
            if (line.trim() === '') continue;
            if (line.search(/\S/) <= indent.length) break;
            commands.push(`${file}: ${line.trim()}`);
          }
        } else if (value) {
          commands.push(`${file}: ${value}`);
        }
      }
    }
    for (const command of commands) {
      expect(command).toMatch(/:\s*(npm (run|ci|install|test)|node scripts\/|pnpm |npx playwright install)/);
    }
  });
});

describe('retention scrub', () => {
  const hex = (seed: string) => createHash('sha256').update(seed).digest('hex');
  const dayMs = 24 * 60 * 60 * 1_000;
  const agoIso = (days: number) => new Date(Date.now() - days * dayMs);

  async function insertInboxEvent(status: string, receivedAt: Date): Promise<string> {
    const client = await getClient();
    const eventId = scopedId('event');
    const orderId = scopedId('order');
    await client`INSERT INTO payment_inbox
      (event_id, event_type, center_order_id, external_order_id, website_id, body_sha256, status, received_at, updated_at)
      VALUES (${eventId}, ${'payment.succeeded'}, ${orderId}, ${orderId}, ${'vitest-site'}, ${hex(eventId)},
        ${status}, ${receivedAt.toISOString()}::timestamptz, ${receivedAt.toISOString()}::timestamptz)`;
    inboxEventIds.push(eventId);
    return eventId;
  }

  async function insertChallenge(expiresAt: Date): Promise<string> {
    const client = await getClient();
    const checkId = hex(scopedId('challenge')).slice(0, 32);
    await client`INSERT INTO payment_handshake_challenges (check_id, site_code, expires_at)
      VALUES (${checkId}, ${scopedId('site')}, ${expiresAt.toISOString()}::timestamptz)`;
    challengeIds.push(checkId);
    return checkId;
  }

  async function countRows(eventIds: string[], checkIds: string[]) {
    const client = await getClient();
    const [events] = await client<{ count: string }[]>`
      SELECT count(*)::text AS count FROM payment_inbox WHERE event_id = ANY(${eventIds})`;
    const [challenges] = await client<{ count: string }[]>`
      SELECT count(*)::text AS count FROM payment_handshake_challenges WHERE check_id = ANY(${checkIds})`;
    return { events: Number(events?.count ?? 0), challenges: Number(challenges?.count ?? 0) };
  }

  async function dropRows(eventIds: string[], checkIds: string[]) {
    const client = await getClient();
    if (eventIds.length > 0) await client`DELETE FROM payment_inbox WHERE event_id = ANY(${eventIds})`;
    if (checkIds.length > 0) {
      await client`DELETE FROM payment_handshake_challenges WHERE check_id = ANY(${checkIds})`;
    }
    for (const id of eventIds) inboxEventIds.splice(inboxEventIds.indexOf(id), 1);
    for (const id of checkIds) challengeIds.splice(challengeIds.indexOf(id), 1);
  }

  it('falls back to the documented windows when a value is missing or unreadable', () => {
    vi.stubEnv('COMPLETED_PAYLOAD_RETENTION_DAYS', '');
    vi.stubEnv('FAILED_PAYLOAD_RETENTION_DAYS', 'not-a-number');
    vi.stubEnv('AUDIT_RETENTION_DAYS', '-5');

    expect(maintenance.retentionPolicy()).toEqual({
      completedPayloadDays: 30, failedPayloadDays: 90, auditDays: 365,
    });

    vi.stubEnv('COMPLETED_PAYLOAD_RETENTION_DAYS', '0');
    vi.stubEnv('FAILED_PAYLOAD_RETENTION_DAYS', '999999');
    vi.stubEnv('AUDIT_RETENTION_DAYS', '7.5');
    // A zero, an absurd and a fractional window all fall back rather than
    // silently disabling the cleanup.
    expect(maintenance.retentionPolicy()).toEqual({
      completedPayloadDays: 30, failedPayloadDays: 90, auditDays: 365,
    });
  });

  it('reads the windows from the environment and maps them to terminal states', () => {
    vi.stubEnv('COMPLETED_PAYLOAD_RETENTION_DAYS', '14');
    vi.stubEnv('FAILED_PAYLOAD_RETENTION_DAYS', '45');
    vi.stubEnv('AUDIT_RETENTION_DAYS', '500');

    const policy = maintenance.retentionPolicy();
    expect(policy).toEqual({ completedPayloadDays: 14, failedPayloadDays: 45, auditDays: 500 });
    expect(maintenance.retentionDaysFor(policy, 'completed')).toBe(14);
    expect(maintenance.retentionDaysFor(policy, 'failed')).toBe(45);
    expect(maintenance.retentionDaysFor(policy, 'manual_review')).toBe(45);
  });

  it('previews exactly what a scrub would remove and then removes nothing', async () => {
    const now = new Date();
    const expiredEvent = await insertInboxEvent('processed', agoIso(40)); // window 30
    const expiredEvent2 = await insertInboxEvent('quarantined', agoIso(100)); // window 90
    const liveEvent = await insertInboxEvent('processed', agoIso(1));
    const expiredChallenge = await insertChallenge(agoIso(400)); // window 365
    const liveChallenge = await insertChallenge(new Date(now.getTime() + dayMs));
    const events = [expiredEvent, expiredEvent2, liveEvent];
    const challenges = [expiredChallenge, liveChallenge];

    try {
      const preview = await maintenance.countRetention(now);
      expect(preview).toMatchObject({
        withdrawalAccountsScrubbed: 0,
        completedEventsPruned: 1,
        failedEventsPruned: 1,
        expiredChallengesPruned: 1,
      });

      const dryRun = await maintenance.runMaintenance(now, { dryRun: true });
      expect(dryRun.dryRun).toBe(true);
      expect(dryRun).toMatchObject({
        completedEventsPruned: 1, failedEventsPruned: 1, expiredChallengesPruned: 1,
      });
      expect(dryRun.durationMs).toBeGreaterThanOrEqual(0);
      // A preview is a promise about the rows, so every row must still be there.
      expect(await countRows(events, challenges)).toEqual({ events: 3, challenges: 2 });
    } finally {
      await dropRows(events, challenges);
    }
  });

  it('scrubs the expired rows, keeps the live ones and changes nothing on a second pass', async () => {
    const now = new Date();
    const expiredEvent = await insertInboxEvent('processed', agoIso(40));
    const expiredEvent2 = await insertInboxEvent('quarantined', agoIso(100));
    const liveEvent = await insertInboxEvent('processed', agoIso(1));
    const expiredChallenge = await insertChallenge(agoIso(400));
    const liveChallenge = await insertChallenge(new Date(now.getTime() + dayMs));
    const events = [expiredEvent, expiredEvent2, liveEvent];
    const challenges = [expiredChallenge, liveChallenge];

    try {
      const scrub = await maintenance.runMaintenance(now);
      expect(scrub.dryRun).toBe(false);
      expect(scrub).toMatchObject({
        withdrawalAccountsScrubbed: 0,
        completedEventsPruned: 1,
        failedEventsPruned: 1,
        expiredChallengesPruned: 1,
      });
      expect(scrub.policy).toEqual(maintenance.retentionPolicy());
      expect(await countRows([expiredEvent, expiredEvent2], [expiredChallenge])).toEqual({ events: 0, challenges: 0 });
      expect(await countRows([liveEvent], [liveChallenge])).toEqual({ events: 1, challenges: 1 });

      const again = await maintenance.runMaintenance(now);
      expect(again).toMatchObject({
        withdrawalAccountsScrubbed: 0,
        completedEventsPruned: 0,
        failedEventsPruned: 0,
        expiredChallengesPruned: 0,
      });
      // Idempotent: the pass that follows removes nothing and the live rows survive.
      expect(await countRows([liveEvent], [liveChallenge])).toEqual({ events: 1, challenges: 1 });
    } finally {
      await dropRows(events, challenges);
    }
  });

  it('keeps the completed window short and the failed window long, as documented', () => {
    const policy = maintenance.retentionPolicy();
    expect(policy.completedPayloadDays).toBeLessThan(policy.failedPayloadDays);
    expect(policy.failedPayloadDays).toBeLessThan(policy.auditDays);
  });
});
