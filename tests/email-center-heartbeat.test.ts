import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 保活心跳——让邮件中心那边的「已接通」反映的是"服务还在、还连得上"，
 * 而不是"最近刚好有人注册"。
 *
 * 背景写在 `lib/email-center/heartbeat.ts` 开头，另见 memory「邮件中心徽章是 15 分钟心跳」。
 *
 * 这个文件不碰数据库，只盯两件事：
 * 1. **探活函数自己的契约**：发出什么请求、成功返回什么、失败必须**抛错**而不是
 *    悄悄返回一个假值（runner 只在 job 抛错时记 warn）。
 * 2. **常驻 runner 里的间隔**——这是整件事的承重墙。邮件中心的判据是"15 分钟内被调过"，
 *    间隔一旦被调到窗口之上，徽章又会自己变红，而这次是静默的。
 */
process.env.FEATURE_EMAIL_CENTER = 'true';

type HeartbeatModule = typeof import('@/lib/email-center/heartbeat');
type BackgroundModule = typeof import('@/lib/jobs/background');

let heartbeat: HeartbeatModule;
let background: BackgroundModule;

/** 邮件中心判断「已接通」的窗口（`applications.lastApiUsedAt` 的 freshness interval）。 */
const EMAIL_CENTER_WINDOW_MS = 15 * 60_000;

beforeAll(async () => {
  [heartbeat, background] = await Promise.all([
    import('@/lib/email-center/heartbeat'),
    import('@/lib/jobs/background'),
  ]);
});

// 探活函数第一件事是 `requireCapability('emailCenter')`，它要看到 URL 和密钥都在。
// 这两项必须由测试自己给：靠本地 .env 恰好填了才绿，就是"测试没在测它声称测的"——
// 换台机器、或者 .env 被清空，第一个用例会红；更糟的是下面那六个"必须抛错"的用例
// 会因为能力没配而全部"通过"，看着比真的还绿。
beforeEach(() => {
  vi.stubEnv('EMAIL_CENTER_URL', 'https://email.example.com');
  vi.stubEnv('EMAIL_CENTER_API_KEY', 'ec_live_vitest_key_0123456789abcdef');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Call = { url: URL; init: RequestInit };

/** 记录应用发出的每一个请求的 fetch 替身。 */
function spySend(respond: (url: URL, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const send = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    const request = init ?? {};
    calls.push({ url, init: request });
    return respond(url, request);
  }) as typeof fetch;
  return { calls, send };
}

function verifyReceipt(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    data: {
      connected: true, applicationId: 42,
      capabilities: { contactReconciliation: 'v1' }, ...overrides,
    },
  });
}

describe('keepalive heartbeat', () => {
  it('posts the server key to the verify endpoint and reports which application answered', async () => {
    const { calls, send } = spySend(() => verifyReceipt());

    const receipt = await heartbeat.verifyEmailCenterConnection({ send });

    expect(receipt).toEqual({ applicationId: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.href)
      .toBe(new URL('/api/v1/integrations/verify', process.env.EMAIL_CENTER_URL).href);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.cache).toBe('no-store');
    expect(new Headers(calls[0].init.headers).get('authorization'))
      .toBe(`Bearer ${process.env.EMAIL_CENTER_API_KEY}`);
  });

  it('throws instead of returning a falsy value, so the runner records the failure', async () => {
    // 这是承重的：runner 只在 job 抛错时记 warn。返回 false 会被当成"这一趟跑成功了"，
    // 探活失败就再也没人知道——正是"错误码不能说谎"那条。
    //
    // 每一行都带上它**该**抛出的那句话。只写 `rejects.toThrow()` 是不够的：能力没配、
    // 参数拼错之类的无关错误一样会让它变绿，六个用例会一起"通过"而什么都没验到。
    const refused: Array<[string, () => Response, RegExp]> = [
      ['the centre cannot be reached', () => { throw new Error('ECONNREFUSED'); }, /ECONNREFUSED/],
      ['the application key is rejected', () => new Response('', { status: 401 }), /HTTP_401/],
      ['the application is not connected', () => verifyReceipt({ connected: false }), /INVALID_VERIFY_RESPONSE/],
      ['the answer carries no application id', () => verifyReceipt({ applicationId: null }), /INVALID_VERIFY_RESPONSE/],
      ['the centre speaks an older reconciliation contract',
        () => verifyReceipt({ capabilities: { contactReconciliation: 'v0' } }), /INVALID_VERIFY_RESPONSE/],
      ['the answer is not the documented shape at all', () => Response.json({ ok: true }), /INVALID_VERIFY_RESPONSE/],
    ];

    for (const [label, respond, expected] of refused) {
      const { send } = spySend(respond);
      await expect(heartbeat.verifyEmailCenterConnection({ send }), label).rejects.toThrow(expected);
    }
  });

  it('refuses to put the key on the wire in clear text in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EMAIL_CENTER_URL', 'http://email.example.com');
    vi.stubEnv('EMAIL_CENTER_API_KEY', 'ec_live_vitest_key_0123456789abcdef');
    const { calls, send } = spySend(() => verifyReceipt());

    await expect(heartbeat.verifyEmailCenterConnection({ send })).rejects.toThrow(/INSECURE/);
    expect(calls).toHaveLength(0); // 拒绝得够早，钥匙根本没上过网
  });
});

describe('the resident runner keeps the connection fresh', () => {
  const heartbeatJob = () => background.BACKGROUND_JOBS.find((entry) => entry.kind === 'email-verify');

  it('carries a keepalive job at all', () => {
    expect(heartbeatJob(), 'the resident runner must carry a keepalive heartbeat').toBeDefined();
  });

  it('pings well inside the freshness window the Email Center actually judges on', () => {
    const job = heartbeatJob()!;

    // 三倍余量：中间漏掉一两次也不会闪红。这条断言是防"有人把间隔调大"的——
    // 调到 15 分钟以上，徽章会重新变成红的，而且没有任何报错。
    expect(job.intervalMs).toBeGreaterThan(0);
    expect(job.intervalMs * 3).toBeLessThanOrEqual(EMAIL_CENTER_WINDOW_MS);
  });

  it('stays quiet unless the integration is really configured', () => {
    const job = heartbeatJob()!;
    vi.stubEnv('EMAIL_CENTER_URL', 'https://email.tradenow.top');
    vi.stubEnv('EMAIL_CENTER_API_KEY', 'ec_live_vitest_key_0123456789abcdef');
    expect(job.enabled()).toBe(true);

    // 没配好还照发，就是每 5 分钟往日志里丢一条 warn，把真正的故障淹掉。
    vi.stubEnv('EMAIL_CENTER_API_KEY', '');
    expect(job.enabled()).toBe(false);
  });
});
