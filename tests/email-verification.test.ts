/**
 * W1 — the transactional-email side of identity.
 *
 * AC 29 : registration and sign-in never send an email code or login link; email
 *         ownership confirmation and password reset use a *separate*
 *         transactional-email link, and that is the Resend API, never the Email
 *         Center campaign API. When mail is unconfigured those actions must be
 *         explicitly unavailable rather than silently "successful".
 * AC 42 : registration needs no ownership confirmation; the protected email
 *         change additionally requires a confirmed address.
 *
 * The only mocked component is the outbound mail provider (`https://api.resend.com`).
 * Everything else — Better Auth, the route handler, PostgreSQL, the tokens — is real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupFixtures, closeClient, getClient, scopedEmail } from './support/fixtures';

// Module scope on purpose: `lib/config.ts` snapshots `features` on first
// evaluation and every import below is dynamic so the snapshot happens after this.
process.env.FEATURE_TRANSACTIONAL_EMAIL = 'true';
process.env.RESEND_API_KEY = 're_harness_test_key';
process.env.EMAIL_FROM = 'SaaS <no-reply@example.test>';
process.env.FEATURE_TURNSTILE = 'false';
delete process.env.TRANSACTIONAL_EMAIL_API_URL;

const BASE = 'http://localhost:3000';
const PASSWORD = 'correct-horse-battery-staple';

type AuthRoute = typeof import('../app/api/auth/[...all]/route');
type AuthModule = typeof import('../lib/auth');
type Resend = typeof import('../lib/transactional-email/resend');
type Config = typeof import('../lib/config');

let route: AuthRoute;
let authModule: AuthModule;
let resend: Resend;
let getCapabilities: Config['getCapabilities'];
let requireCapability: Config['requireCapability'];
let client: Awaited<ReturnType<typeof getClient>>;
const userIds: string[] = [];

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
const sent: Sent[] = [];

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
}

function get(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { method: 'GET', headers });
}

function cookieOf(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
}

function jsonHeaders(init?: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

/**
 * Captures the outbound Resend call. Registration also pushes the referral
 * profile to the Payment Center: that is a separate channel, answered here
 * without being recorded, so these assertions stay about mail exactly as
 * AC 29 intends.
 */
function mockMailbox() {
  sent.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/referral-center/')) {
      return Response.json({ status: 'success', data: { user: {} } });
    }
    sent.push({
      url: String(input), headers: jsonHeaders(init),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return Response.json({ id: 'resend-message-id' });
  }));
}

/** Better Auth may dispatch the send in the background, so wait for the side effect. */
async function waitForMail(count = 1, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (sent.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return sent;
}

function linkIn(mail: Sent): URL {
  const match = /https?:\/\/\S+/.exec(String(mail.body.text ?? ''));
  if (!match) throw new Error('The mail body contains no link');
  return new URL(match[0]);
}

async function resetRateLimits() {
  await client`DELETE FROM "rateLimit"`;
}

async function signUp(extra: Record<string, unknown> = {}) {
  await resetRateLimits();
  const email = scopedEmail();
  const response = await route.POST(post('/api/auth/sign-up/email', {
    name: 'Mail Fixture', email, password: PASSWORD, ...extra,
  }));
  const body = await response.json() as { user?: { id: string } };
  if (body.user?.id) userIds.push(body.user.id);
  return { email, response, body, cookie: cookieOf(response) };
}

async function verifiedState(email: string) {
  const [user] = await client<{ email_verified: boolean }[]>`
    SELECT email_verified FROM "user" WHERE email = ${email}`;
  return user.email_verified;
}

beforeAll(async () => {
  route = await import('../app/api/auth/[...all]/route');
  authModule = await import('../lib/auth');
  resend = await import('../lib/transactional-email/resend');
  const config = await import('../lib/config');
  getCapabilities = config.getCapabilities;
  requireCapability = config.requireCapability;
  client = await getClient();
});

afterAll(async () => {
  await cleanupFixtures({ userIds });
  await closeClient();
});

describe('AC 29 — the mail channel is the transactional API, not the campaign API', () => {
  it('has the capability configured and both senders wired into Better Auth', () => {
    expect(getCapabilities().transactionalEmail).toMatchObject({ enabled: true, configured: true, missing: [] });
    expect(authModule.auth.options.user?.changeEmail?.enabled).toBe(true);
    expect(typeof authModule.auth.options.emailAndPassword?.sendResetPassword).toBe('function');
    expect(typeof authModule.auth.options.emailVerification?.sendVerificationEmail).toBe('function');
  });

  it('sends nothing at all on registration and leaves the address unverified', async () => {
    mockMailbox();
    try {
      const { email, response } = await signUp({ preferredLocale: 'en' });
      expect(response.status).toBe(200);
      await waitForMail(0, 300);
      expect(sent).toEqual([]);
      expect(await verifiedState(email)).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it('posts the ownership link to Resend with a stable idempotency key, and the link verifies the address', async () => {
    mockMailbox();
    try {
      const { email, cookie } = await signUp();
      expect(await verifiedState(email)).toBe(false);

      const response = await route.POST(post('/api/auth/send-verification-email',
        { email, callbackURL: '/dashboard/activity' }, { cookie }));
      expect(response.status).toBe(200);

      const [mail] = await waitForMail();
      expect(mail.url).toBe('https://api.resend.com/emails');
      // AC 29: the campaign API (Email Center) must never carry auth mail.
      expect(mail.url).not.toContain(process.env.EMAIL_CENTER_URL ?? '127.0.0.1:3100');
      expect(mail.headers.authorization).toBe(`Bearer ${process.env.RESEND_API_KEY}`);
      expect(mail.headers['content-type']).toBe('application/json');
      expect(mail.body).toMatchObject({ from: process.env.EMAIL_FROM, to: [email] });

      const link = linkIn(mail);
      expect(link.origin).toBe(BASE);
      expect(link.pathname).toBe('/api/auth/verify-email');
      const token = link.searchParams.get('token');
      expect(token).toBeTruthy();
      // The caller asked for /dashboard/activity; the sender pins the safe return path.
      expect(link.searchParams.get('callbackURL')).toBe('/dashboard/general');
      const { createHash } = await import('node:crypto');
      expect(mail.headers['idempotency-key'])
        .toBe(createHash('sha256').update(`email-ownership:${token}`).digest('hex'));

      const confirmed = await route.GET(get(link.toString()));
      expect([302, 307]).toContain(confirmed.status);
      expect(confirmed.headers.get('location') ?? '').toContain('/dashboard/general');
      expect(await verifiedState(email)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it('refuses an off-site callback and consumes the verification link only once', async () => {
    mockMailbox();
    try {
      const { email, cookie } = await signUp();

      const offSite = await route.POST(post('/api/auth/send-verification-email',
        { email, callbackURL: 'https://wrong.example.invalid/' }, { cookie }));
      expect(offSite.status).toBe(403);
      await waitForMail(0, 300);
      expect(sent).toEqual([]);
      expect(await verifiedState(email)).toBe(false);

      const onSite = await route.POST(post('/api/auth/send-verification-email',
        { email, callbackURL: '/dashboard/activity' }, { cookie }));
      expect(onSite.status).toBe(200);
      const [mail] = await waitForMail();
      const link = linkIn(mail);

      expect([302, 307]).toContain((await route.GET(get(link.toString()))).status);
      expect(await verifiedState(email)).toBe(true);

      // Replaying the token must not re-confirm or re-issue anything. Better Auth
      // answers an already-verified address with the same redirect instead of an
      // error, so the proof is that it mints no session and changes no state.
      const replay = await route.GET(get(link.toString()));
      expect([302, 307]).toContain(replay.status);
      expect(replay.headers.get('location') ?? '').toContain('/dashboard/general');
      expect(replay.headers.getSetCookie().join(';')).not.toContain('session_token');
      expect(await verifiedState(email)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('AC 29 / AC 42 — password reset', () => {
  it('refuses an off-site redirectTo, stays silent for an unknown address, and keeps the link on site', async () => {
    mockMailbox();
    try {
      const { email } = await signUp();
      await resetRateLimits();

      const offSite = await route.POST(post('/api/auth/request-password-reset',
        { email, redirectTo: 'https://wrong.example.invalid/reset-password' }));
      expect(offSite.status).toBe(403);
      await waitForMail(0, 300);
      expect(sent).toEqual([]);

      const unknown = await route.POST(post('/api/auth/request-password-reset',
        { email: scopedEmail(), redirectTo: `${BASE}/en/reset-password` }));
      expect(unknown.status).toBe(200);
      await waitForMail(0, 300);
      expect(sent).toEqual([]);

      await resetRateLimits();
      const onSite = await route.POST(post('/api/auth/request-password-reset',
        { email, redirectTo: `${BASE}/zh-CN/reset-password` }));
      expect(onSite.status).toBe(200);
      const [mail] = await waitForMail();
      expect(mail.url).toBe('https://api.resend.com/emails');
      const link = linkIn(mail);
      expect(link.origin).toBe(BASE);
      expect(link.pathname).toMatch(/^\/api\/auth\/reset-password\/.+$/);
      expect(link.searchParams.get('callbackURL')).toBe(`${BASE}/zh-CN/reset-password`);
    } finally { vi.unstubAllGlobals(); }
  });

  it('exchanges the token once, revokes the old sessions and rotates the password', async () => {
    mockMailbox();
    try {
      const { email, cookie } = await signUp();
      expect(cookie).toContain('better-auth.session_token');
      // Sign-in is refused until the mailbox is confirmed, and this test ends
      // by signing in with the rotated password. The mailbox itself is not
      // what is under test here, so it starts confirmed.
      await client`UPDATE "user" SET email_verified = true WHERE email = ${email}`;
      await resetRateLimits();

      const requested = await route.POST(post('/api/auth/request-password-reset',
        { email, redirectTo: `${BASE}/en/reset-password` }));
      expect(requested.status).toBe(200);
      const [mail] = await waitForMail();
      const token = decodeURIComponent(linkIn(mail).pathname.split('/').pop()!);
      expect(token).toBeTruthy();

      const reset = await route.POST(post('/api/auth/reset-password',
        { newPassword: 'a-brand-new-passphrase', token }));
      expect(reset.status).toBe(200);

      const replay = await route.POST(post('/api/auth/reset-password',
        { newPassword: 'yet-another-passphrase', token }));
      expect(replay.status).toBeGreaterThanOrEqual(400);

      // revokeSessionsOnPasswordReset
      expect(await (await route.GET(get(`${BASE}/api/auth/get-session`, { cookie }))).json()).toBeNull();

      await resetRateLimits();
      const stale = await route.POST(post('/api/auth/sign-in/email', { email, password: PASSWORD }));
      expect(stale.status).toBeGreaterThanOrEqual(400);
      await resetRateLimits();
      const fresh = await route.POST(post('/api/auth/sign-in/email', {
        email, password: 'a-brand-new-passphrase',
      }));
      expect(fresh.status).toBe(200);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('AC 29 — with mail unconfigured the actions are explicitly unavailable', () => {
  it('throws a named capability error instead of pretending to send', async () => {
    const { email, cookie } = await signUp();
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('EMAIL_FROM', '');
    try {
      expect(getCapabilities().transactionalEmail).toMatchObject({ configured: false });

      expect(() => requireCapability('transactionalEmail'))
        .toThrow('transactionalEmail is unavailable: RESEND_API_KEY, EMAIL_FROM');
      await expect(resend.sendTransactionalEmail({
        to: email, subject: 'x', text: 'x', operationKey: 'x',
      })).rejects.toThrow('transactionalEmail is unavailable');

      // The protected email change must say so, not silently do nothing.
      await resetRateLimits();
      const change = await route.POST(post('/api/auth/account/request-email-change',
        { newEmail: scopedEmail(), password: PASSWORD },
        { cookie, origin: BASE }));
      expect(change.status).toBe(503);
      expect(await change.json()).toMatchObject({ code: 'EMAIL_CHANGE_UNAVAILABLE' });

      // A reset request cannot succeed without a channel to deliver the link.
      // Better Auth would answer 200 and send nothing, which is exactly the
      // "silently successful" answer AC 29 forbids, so the route refuses first.
      mockMailbox();
      await resetRateLimits();
      const requested = await route.POST(post('/api/auth/request-password-reset',
        { email, redirectTo: `${BASE}/en/reset-password` }));
      expect(requested.status).toBe(503);
      expect(await requested.json()).toMatchObject({ code: 'TRANSACTIONAL_EMAIL_UNAVAILABLE' });
      await waitForMail(0, 300);
      expect(sent).toEqual([]);

      // The ownership link is unavailable for the same reason.
      const verification = await route.POST(post('/api/auth/send-verification-email',
        { email, callbackURL: '/dashboard/general' }, { cookie }));
      expect(verification.status).toBe(503);
      expect(await verification.json()).toMatchObject({ code: 'TRANSACTIONAL_EMAIL_UNAVAILABLE' });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

