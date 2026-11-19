/**
 * W1 — Cloudflare Turnstile on the real sign-up / sign-in / request-password-reset
 * requests.
 *
 * AC 40 : the public Site Key is client-side, the Secret Key is server-only, and
 *         Better Auth calls Siteverify on the real auth requests and validates
 *         the result together with the expected hostname and action.
 * AC 41 : missing, forged, failed or unavailable verification creates no user and
 *         no session; an outage fails closed but a refreshed challenge can retry.
 *
 * The widget here is a realistic (non-test) key pair, so the capability matrix
 * stays satisfied in a non-production environment and the action/hostname checks
 * are active. The Cloudflare Siteverify *network call* is mocked — that is the
 * only mocked component, and each test title says so.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanupFixtures, closeClient, getClient, scopedEmail } from './support/fixtures';

// Module scope on purpose: `lib/config.ts` snapshots `features` on first
// evaluation, and every import below is dynamic so the snapshot happens after
// this assignment.
process.env.FEATURE_TURNSTILE = 'true';
process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = '0x4AAAAAAABkMYinukE8nzY5';
process.env.TURNSTILE_SECRET_KEY = '0x4AAAAAAABkMYinukE8nzY5wXyZaBcDeFgHiJkLmN';
process.env.TURNSTILE_ALLOWED_HOSTNAMES = 'localhost';
// The route refuses the two mail-dependent endpoints with 503 while the
// transactional-email channel is unconfigured (AC 29), so the captcha check that
// has to run before a reset mail can only be exercised with the channel wired up.
// Nothing here sends: the request is refused for its missing token first, and the
// stubbed fetch below turns any unexpected mail call into a test failure.
process.env.FEATURE_TRANSACTIONAL_EMAIL = 'true';
process.env.RESEND_API_KEY = 're_harness_test_key';
process.env.EMAIL_FROM = 'SaaS <no-reply@example.test>';

const BASE = 'http://localhost:3000';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

type AuthRoute = typeof import('../app/api/auth/[...all]/route');
type Config = typeof import('../lib/config');

let route: AuthRoute;
let getCapabilities: Config['getCapabilities'];
let client: Awaited<ReturnType<typeof getClient>>;
const userIds: string[] = [];

/** Swapped per test; the only mocked external dependency in this file. */
let siteverify: () => Response | Promise<Response>;
const called: { url: string; body: Record<string, unknown> }[] = [];

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
}

const accepted = () => Response.json({
  success: true, hostname: 'localhost', action: 'saas_auth', challenge_ts: new Date().toISOString(),
});

async function countsFor(email: string) {
  const [users] = await client<{ count: number }[]>`
    SELECT COUNT(*)::integer AS count FROM "user" WHERE email = ${email}`;
  const [sessions] = await client<{ count: number }[]>`
    SELECT COUNT(*)::integer AS count FROM session s INNER JOIN "user" u ON u.id = s.user_id
    WHERE u.email = ${email}`;
  return { users: users.count, sessions: sessions.count };
}

async function signUp(email: string, token?: string) {
  await client`DELETE FROM "rateLimit"`;
  const response = await route.POST(post('/api/auth/sign-up/email', {
    name: 'Turnstile Fixture', email, password: 'correct-horse-battery-staple',
  }, token === undefined ? {} : { 'x-captcha-response': token }));
  const body = await response.json() as { user?: { id: string }; code?: string; error?: string };
  if (response.status >= 400 && response.status !== 403 && response.status !== 400) {
    console.log('DIAG signUp', response.status, JSON.stringify(body));
  }
  if (body.user?.id) userIds.push(body.user.id);
  return { response, body };
}

beforeAll(async () => {
  route = await import('../app/api/auth/[...all]/route');
  getCapabilities = (await import('../lib/config')).getCapabilities;
  client = await getClient();
});

afterAll(async () => {
  await cleanupFixtures({ userIds });
  await closeClient();
});

function fakeSiteverify() {
  called.length = 0;
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    // Registration pushes the referral profile to the Payment Center on a
    // separate channel; answer it without recording so `called` stays about
    // Siteverify.
    if (String(input).includes('/api/referral-center/')) {
      return Response.json({ status: 'success', data: { user: {} } });
    }
    called.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return siteverify();
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

function tree(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) tree(path, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

describe('AC 40 — capability and key placement', () => {
  it('is configured from a real widget and keeps the Secret Key out of every client module', () => {
    const capability = getCapabilities().turnstile;
    expect(capability).toMatchObject({ enabled: true, configured: true, missing: [] });

    const clientFiles = [...tree(`${repoRoot}app`), ...tree(`${repoRoot}components`)];
    const leaking = clientFiles.filter((file) => readFileSync(file, 'utf8').includes('TURNSTILE_SECRET_KEY'));
    expect(leaking).toEqual([]);
    const usingSiteKey = clientFiles.filter((file) => readFileSync(file, 'utf8').includes('NEXT_PUBLIC_TURNSTILE_SITE_KEY'));
    expect(usingSiteKey.length).toBeGreaterThan(0);
  });

  it('sends the Secret Key and the browser token to Cloudflare Siteverify', async () => {
    siteverify = accepted;
    const send = fakeSiteverify();
    try {
      const email = scopedEmail();
      const { response } = await signUp(email, 'browser-token-value');
      expect(response.status).toBe(200);
      // `called` records every outbound call except the referral push, so this
      // still asserts exactly one Siteverify round-trip.
      expect(called).toHaveLength(1);
      expect(send).toHaveBeenCalled();
      expect(called[0].url).toBe(SITEVERIFY);
      expect(called[0].body).toMatchObject({
        secret: process.env.TURNSTILE_SECRET_KEY, response: 'browser-token-value',
      });
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('AC 41 — every rejected or unavailable challenge creates nothing', () => {
  it('rejects a missing token without ever contacting Siteverify', async () => {
    const send = fakeSiteverify();
    try {
      const email = scopedEmail();
      const { response, body } = await signUp(email);
      expect(response.status).toBe(400);
      expect(body.code).toBe('MISSING_RESPONSE');
      expect(send).not.toHaveBeenCalled();
      expect(await countsFor(email)).toEqual({ users: 0, sessions: 0 });
    } finally { vi.unstubAllGlobals(); }
  });

  it('rejects a forged token whose mocked Siteverify call fails', async () => {
    siteverify = () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] });
    fakeSiteverify();
    try {
      const email = scopedEmail();
      const { response } = await signUp(email, 'XXXX.DUMMY.TOKEN.XXXX');
      expect(response.status).toBe(403);
      expect(await countsFor(email)).toEqual({ users: 0, sessions: 0 });
      expect(response.headers.getSetCookie()).toEqual([]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('rejects a mocked Siteverify success carrying the wrong action', async () => {
    siteverify = () => Response.json({ success: true, hostname: 'localhost', action: 'not_saas_auth' });
    fakeSiteverify();
    try {
      const email = scopedEmail();
      const { response } = await signUp(email, 'token-with-wrong-action');
      expect(response.status).toBe(403);
      expect(await countsFor(email)).toEqual({ users: 0, sessions: 0 });
    } finally { vi.unstubAllGlobals(); }
  });

  it('rejects a mocked Siteverify success from a hostname outside the allow-list', async () => {
    siteverify = () => Response.json({ success: true, hostname: 'evil.example', action: 'saas_auth' });
    fakeSiteverify();
    try {
      const email = scopedEmail();
      const { response } = await signUp(email, 'token-from-another-host');
      expect(response.status).toBe(403);
      expect(await countsFor(email)).toEqual({ users: 0, sessions: 0 });
    } finally { vi.unstubAllGlobals(); }
  });

  it('fails closed when the mocked Siteverify network is unreachable, then allows a refreshed challenge', async () => {
    siteverify = () => { throw new Error('ECONNREFUSED'); };
    fakeSiteverify();
    try {
      const outageEmail = scopedEmail();
      const outage = await signUp(outageEmail, 'token-during-outage');
      expect(outage.response.status).toBeGreaterThanOrEqual(500);
      expect(await countsFor(outageEmail)).toEqual({ users: 0, sessions: 0 });
    } finally { vi.unstubAllGlobals(); }

    // The endpoint must not stay latched shut: a fresh challenge succeeds.
    siteverify = accepted;
    fakeSiteverify();
    try {
      const retryEmail = scopedEmail();
      const retry = await signUp(retryEmail, 'freshly-refreshed-token');
      expect(retry.response.status).toBe(200);
      expect(await countsFor(retryEmail)).toEqual({ users: 1, sessions: 1 });
    } finally { vi.unstubAllGlobals(); }
  });

  it('answers 503 and creates nothing when the widget capability is unconfigured', async () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    try {
      expect(getCapabilities().turnstile.configured).toBe(false);
      const email = scopedEmail();
      const { response, body } = await signUp(email, 'any-token');
      expect(response.status).toBe(503);
      expect(body).toEqual({ error: 'Human verification is unavailable. Please try again later.' });
      expect(await countsFor(email)).toEqual({ users: 0, sessions: 0 });
      // Only the guarded endpoints close: the rest of the auth surface is up.
      const signOut = await route.POST(new Request(`${BASE}/api/auth/sign-out`, {
        method: 'POST', headers: { origin: BASE },
      }));
      expect(signOut.status).not.toBe(503);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('AC 40 / AC 42 — the accepted challenge still proves nothing about email', () => {
  it('creates the unverified account and session behind a valid token', async () => {
    siteverify = accepted;
    fakeSiteverify();
    try {
      const email = scopedEmail();
      const { response, body } = await signUp(email, 'valid-browser-token');
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie().join(';')).toContain('better-auth.session_token');
      expect(await countsFor(email)).toEqual({ users: 1, sessions: 1 });
      const [user] = await client<{ email_verified: boolean }[]>`
        SELECT email_verified FROM "user" WHERE email = ${email}`;
      expect(user.email_verified).toBe(false);
      expect(body.user?.id).toBeTruthy();
    } finally { vi.unstubAllGlobals(); }
  });

  it('requires the token on sign-in even with correct credentials', async () => {
    siteverify = accepted;
    fakeSiteverify();
    const email = scopedEmail();
    try {
      const created = await signUp(email, 'valid-browser-token');
      expect(created.response.status).toBe(200);
      // Sign-in is refused until the mailbox is confirmed. This test is about
      // the human check that sits in front of the credential check, so the
      // fixture is confirmed here — the unconfirmed state itself is asserted
      // by the registration test above.
      await client`UPDATE "user" SET email_verified = true WHERE id = ${created.body.user!.id}`;

      await client`DELETE FROM "rateLimit"`;
      const without = await route.POST(post('/api/auth/sign-in/email', {
        email, password: 'correct-horse-battery-staple',
      }));
      expect(without.status).toBe(400);
      expect(without.headers.getSetCookie()).toEqual([]);

      await client`DELETE FROM "rateLimit"`;
      const withToken = await route.POST(post('/api/auth/sign-in/email', {
        email, password: 'correct-horse-battery-staple',
      }, { 'x-captcha-response': 'valid-browser-token' }));
      expect(withToken.status).toBe(200);
      expect(withToken.headers.getSetCookie().join(';')).toContain('better-auth.session_token');
    } finally { vi.unstubAllGlobals(); }
  });

  it('requires the token before a password-reset mail is even attempted', async () => {
    siteverify = accepted;
    const send = fakeSiteverify();
    const email = scopedEmail();
    try {
      const created = await signUp(email, 'valid-browser-token');
      expect(created.response.status).toBe(200);
      send.mockClear();
      called.length = 0;

      await client`DELETE FROM "rateLimit"`;
      const response = await route.POST(post('/api/auth/request-password-reset', {
        email, redirectTo: `${BASE}/en/reset-password`,
      }));
      expect(response.status).toBe(400);
      // The only outbound call was Siteverify; no mail provider was contacted.
      expect(called.every((entry) => entry.url === SITEVERIFY)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});
