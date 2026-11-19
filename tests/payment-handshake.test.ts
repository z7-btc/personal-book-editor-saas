/**
 * Payment Center -> SaaS handshake contract (plan AC 17).
 *
 * The live Payment Center is not required here: a stub bound to loopback answers
 * the catalog and referral-site calls, and the test names say so. Everything
 * else is real — an isolated migrated PostgreSQL database, the real signature
 * check, the real one-use challenge table and the real module report.
 *
 * `lib/config.ts` snapshots `features` when the module is first evaluated and
 * static imports are hoisted above this file's statements, so the environment is
 * set at module scope and the route is imported dynamically from `beforeAll`
 * (same working pattern as payment-center-contract.test.ts).
 */
process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.FEATURE_REFERRALS = 'true';
process.env.PAYMENT_CENTER_BASE_URL ||= 'http://127.0.0.1:5000';
process.env.PAYMENT_CENTER_API_KEY ||= 'vitest-payment-center-api-key';
process.env.PAYMENT_CENTER_REFERRAL_API_KEY ||= 'vitest-referral-api-key';
process.env.PAYMENT_CENTER_SITE_CODE ||= 'sf118b3fa313264a';
process.env.PAYMENT_CENTER_WEBSITE_ID ||= '544d8d48-a2a9-4a18-b3a8-4b4ceae7c387';
process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET ||=
  'vitest-callback-signing-secret-0123456789abcdef';
process.env.APP_BASE_URL ||= 'http://localhost:3000';

import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeClient } from './support/fixtures';

type Captured = { method: string; path: string; headers: Record<string, string>; body: string };
type StubReply = { status: number; body?: unknown };

const PRODUCT_CODE = 'vitest-plan';
const SITE_CODE = () => process.env.PAYMENT_CENTER_SITE_CODE as string;
const WEBSITE_ID = () => process.env.PAYMENT_CENTER_WEBSITE_ID as string;

type RouteModule = typeof import('@/app/api/payment-center/handshake/route');

let route: RouteModule;
let server: ReturnType<typeof createServer>;
let captured: Captured[] = [];
/** The referral-site answer, so each test can change what the binding proves. */
let referralReply: StubReply = { status: 200 };
/** The catalog answer, so a test can present an empty catalog. */
let catalogReply: StubReply = { status: 200 };
/** Drops the connection instead of answering, to exercise the network branch. */
let referralHangUp = false;

function catalogBody(products: unknown[], methods: string[] = ['manual']) {
  return {
    status: 'success',
    data: {
      website_id: WEBSITE_ID(),
      site_code: SITE_CODE(),
      site_name: 'Vitest SaaS',
      methods,
      unavailable_methods: {},
      products,
    },
  };
}

function product() {
  return {
    code: PRODUCT_CODE,
    name: 'Vitest plan',
    description: null,
    prices: [{
      interval: 'month', amount: 37.5, amount_decimal: '37.50000000', currency: 'USD',
    }],
  };
}

function referralBody(overrides: { siteCode?: string; isActive?: boolean } = {}) {
  return {
    data: {
      website: {
        id: WEBSITE_ID(),
        site_code: overrides.siteCode ?? SITE_CODE(),
        is_active: overrides.isActive ?? true,
      },
    },
  };
}

function startStub(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') headers[key.toLowerCase()] = value;
        }
        captured.push({
          method: request.method ?? 'GET',
          path: new URL(request.url ?? '/', 'http://stub.invalid').pathname,
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const isReferral = request.url?.startsWith('/api/referral-center/site') ?? false;
        if (isReferral && referralHangUp) {
          request.socket.destroy();
          return;
        }
        const answer = isReferral ? referralReply : catalogReply;
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function challenge(checkId: string, overrides: {
  siteCode?: string; timestamp?: number; secret?: string; modules?: string[];
} = {}): Request {
  const body = JSON.stringify({
    event: 'handshake.check',
    check_id: checkId,
    site_code: overrides.siteCode ?? SITE_CODE(),
    site_name: 'Vitest SaaS',
    checked_at: new Date().toISOString(),
    modules: overrides.modules ?? ['payment_pricing', 'referral', 'payment_callback'],
  });
  const timestamp = String(overrides.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256',
    overrides.secret ?? process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET as string)
    .update(Buffer.from(`${timestamp}.`, 'ascii'))
    .update(Buffer.from(body, 'utf8'))
    .digest('hex');
  return new Request('http://localhost:3000/api/payment-center/handshake', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-payment-center-timestamp': timestamp,
      'x-payment-center-signature': `sha256=${signature}`,
      'x-payment-center-event': checkId,
      'x-payment-center-site': overrides.siteCode ?? SITE_CODE(),
    },
    body,
  });
}

function checkId(): string {
  return randomUUID().replace(/-/g, '');
}

type HandshakeResponse = {
  data: {
    site_version: string;
    required_product_codes: string[];
    modules: Record<string, { status: string; issues: string[] }>;
  };
};

beforeAll(async () => {
  const stubUrl = await startStub();
  process.env.PAYMENT_CENTER_BASE_URL = stubUrl;
  route = await import('@/app/api/payment-center/handshake/route');
});

beforeEach(() => {
  captured = [];
  referralHangUp = false;
  referralReply = { status: 200, body: referralBody() };
  catalogReply = { status: 200, body: catalogBody([product()]) };
});

afterAll(async () => {
  await closeClient();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Payment Center handshake', () => {
  it('reports pricing and referral ready and the callback evidence honestly missing', async () => {
    const response = await route.POST(challenge(checkId()));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as HandshakeResponse;
    expect(body.data.site_version).toBe('local');
    expect(body.data.required_product_codes).toEqual([PRODUCT_CODE]);
    expect(body.data.modules.payment_pricing).toEqual({ status: 'ready', issues: [] });
    expect(body.data.modules.referral).toEqual({ status: 'ready', issues: [] });
    // The isolated database holds no signed callback evidence, so the module
    // must say what is missing instead of claiming a connection it cannot prove.
    expect(body.data.modules.payment_callback).toEqual({
      status: 'failed',
      issues: ['尚无最近七天经签名回调完成的付款及权益证据'],
    });
    const referralCall = captured.find((call) => call.path === '/api/referral-center/site');
    expect(referralCall?.headers['x-api-key']).toBe(process.env.PAYMENT_CENTER_REFERRAL_API_KEY);
  });

  it('reports the referral module failed when the key names another website', async () => {
    referralReply = { status: 200, body: referralBody({ siteCode: 'someone-elses-site' }) };

    const body = await (await route.POST(challenge(checkId()))).json() as HandshakeResponse;

    expect(body.data.modules.referral).toEqual({
      status: 'failed',
      issues: ['返佣专属 Key 无法确认本站绑定，请检查 Key、网站标识与启用状态'],
    });
  });

  it('reports the referral module failed when the referral centre refuses the key', async () => {
    referralReply = { status: 503, body: { status: 'error', message: 'maintenance' } };

    const body = await (await route.POST(challenge(checkId()))).json() as HandshakeResponse;

    expect(body.data.modules.referral).toEqual({
      status: 'failed',
      issues: ['返佣专属 Key 无法确认本站绑定，请检查 Key、网站标识与启用状态'],
    });
  });

  it('reports the referral module failed when the referral centre cannot be reached', async () => {
    referralHangUp = true;

    const body = await (await route.POST(challenge(checkId()))).json() as HandshakeResponse;

    expect(body.data.modules.referral).toEqual({
      status: 'failed',
      issues: ['无法连接返佣中心，请检查返佣中心地址与网络'],
    });
  });

  it('accepts every payment method the center may enable, including ones it does not know yet', async () => {
    // Regression: the host schema used to whitelist four methods, so adding
    // Binance Pay to the centre made the whole catalog unreadable. An unknown
    // future channel must not repeat that.
    catalogReply = {
      status: 200,
      body: catalogBody(
        [product()],
        ['stripe', 'manual', 'blockchain', 'commission_balance', 'binance_pay', 'some_future_channel'],
      ),
    };

    const body = await (await route.POST(challenge(checkId()))).json() as HandshakeResponse;

    expect(body.data.modules.payment_pricing).toEqual({ status: 'ready', issues: [] });
  });

  it('reports pricing failed when the catalog holds no sellable product', async () => {
    catalogReply = { status: 200, body: catalogBody([]) };

    const body = await (await route.POST(challenge(checkId()))).json() as HandshakeResponse;

    expect(body.data.modules.payment_pricing).toEqual({
      status: 'failed',
      issues: ['本站尚无可售商品与价格'],
    });
    expect(body.data.required_product_codes).toEqual([]);
  });

  it('rejects a challenge signed with the wrong secret', async () => {
    const response = await route.POST(challenge(checkId(), {
      secret: 'vitest-wrong-signing-secret-0123456789abcdef',
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_handshake' });
    expect(captured).toHaveLength(0);
  });

  it('rejects a challenge that is replayed with the same check id', async () => {
    const id = checkId();
    const first = await route.POST(challenge(id));
    const second = await route.POST(challenge(id));

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({ error: 'replayed_handshake' });
  });
});
