// 付费门槛：没有有效订阅的账号一个书籍接口都用不了。
//
// 定价页承诺「每月 1 美元使用这个工具」，但在此之前没有任何地方检查订阅，
// 任何登录账号都能把整本书跑完。这个文件锁住三件事：
//   1. 有有效付费周期才放行，过期、被冲正的一律不行；
//   2. 支付中心没配置齐全时不拦（开源用户不该被他们没接的收费系统锁死）；
//   3. 运维开关与邮箱白名单按环境变量生效。
//
// `lib/config.ts` 在首次被导入时快照 FEATURE_* 开关，所以这里先钉住环境，
// 再在 beforeAll 里动态导入被测模块（与 authorization.test.ts 同一做法）。

process.env.FEATURE_PAYMENT_CENTER = 'true';
process.env.PAYMENT_CENTER_BASE_URL = 'http://127.0.0.1:5000';
process.env.PAYMENT_CENTER_API_KEY = 'vitest-payment-center-api-key';
process.env.PAYMENT_CENTER_SITE_CODE = 'sf118b3fa313264a';
process.env.PAYMENT_CENTER_WEBSITE_ID = '544d8d48-a2a9-4a18-b3a8-4b4ceae7c387';
process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET = 'vitest-callback-signing-secret-0123456789abcdef';
process.env.SUBSCRIPTION_ENFORCEMENT = 'enforce';
delete process.env.SUBSCRIPTION_EXEMPT_EMAILS;

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const DAY = 86_400;

type AccessModule = typeof import('@/lib/subscription/access');
type Fixtures = typeof import('./support/fixtures');

let access: AccessModule;
let fixtures: Fixtures;
let personalSlug: (userId: string) => string;

const scope = { userIds: [] as string[], organizationIds: [] as string[], intentIds: [] as string[] };
const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined) {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  fixtures = await import('./support/fixtures');
  access = await import('@/lib/subscription/access');
  ({ personalSlug } = await import('@/lib/workspace/bootstrap'));
});

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

afterAll(async () => {
  await fixtures.cleanupFixtures(scope);
  await fixtures.closeClient();
});

/** 会话里的用户形状 → access 模块的入参。 */
function asSessionUser(user: { userId: string; email: string }) {
  return { id: user.userId, email: user.email, name: 'Vitest Fixture' };
}

/** 一个有个人工作区的用户（slug 与真实注册流程一致）。 */
async function newSubscriber() {
  const user = await fixtures.createUserFixture();
  scope.userIds.push(user.userId);
  const workspace = await fixtures.createOrganizationFixture({
    userId: user.userId,
    slug: personalSlug(user.userId),
  });
  scope.organizationIds.push(workspace.organizationId);
  return { user, organizationId: workspace.organizationId };
}

/**
 * 直接写一条付款凭据 + 授权，覆盖 `settle` 需要的四张表。
 * 这里只关心门槛读的那两列（status、period_end），所以不经支付中心。
 */
async function seedPaidPeriod(
  organizationId: string,
  options: { startOffsetDays: number; endOffsetDays: number; status?: 'active' | 'reversed' },
) {
  const client = await fixtures.getClient();
  const suffix = randomUUID();
  const accountId = `vitest-ba-${suffix}`;
  const intentId = fixtures.scopedId('intent', suffix);
  const evidenceId = fixtures.scopedId('evidence', suffix);
  const grantId = fixtures.scopedId('grant', suffix);
  scope.intentIds.push(intentId);

  const now = Date.now();
  const start = new Date(now + options.startOffsetDays * DAY * 1000);
  const end = new Date(now + options.endOffsetDays * DAY * 1000);

  await client`INSERT INTO billing_accounts
      (id, organization_id, external_billing_id, original_payer_user_id)
    VALUES (${accountId}, ${organizationId}, ${accountId}, ${'vitest-access'})`;
  await client`INSERT INTO payment_intents
      (id, organization_id, billing_account_id, payer_user_id, request_key, product_code,
       price_interval, amount_decimal, currency, method, payment_action, status,
       external_order_id, idempotency_key)
    VALUES (${intentId}, ${organizationId}, ${accountId}, ${'vitest-access'},
      ${randomUUID()}, ${'tool'}, ${'month'}, ${'1.00000000'}, ${'USD'}, ${'stripe'},
      ${'redirect'}, ${'pending'}, ${intentId}, ${intentId})`;
  await client`INSERT INTO payment_evidence
      (id, website_id, organization_id, intent_id, evidence_key, source_event_id,
       center_order_id, amount_decimal, currency, settled_at, service_period_start,
       service_period_end, status)
    VALUES (${evidenceId}, ${'544d8d48-a2a9-4a18-b3a8-4b4ceae7c387'}, ${organizationId},
      ${intentId}, ${evidenceId}, ${randomUUID()}, ${intentId}, ${'1.00000000'}, ${'USD'},
      ${new Date(now).toISOString()}, ${start.toISOString()}, ${end.toISOString()}, ${'settled'})`;
  await client`INSERT INTO subscription_grants
      (id, organization_id, evidence_id, product_code, payment_method,
       period_start, period_end, status)
    VALUES (${grantId}, ${organizationId}, ${evidenceId}, ${'tool'}, ${'stripe'},
      ${start.toISOString()}, ${end.toISOString()}, ${options.status ?? 'active'})`;
}

describe('subscription gate', () => {
  it('拒绝一个没有任何付费周期的账号', async () => {
    const { user } = await newSubscriber();
    const result = await access.resolveToolAccess(asSessionUser(user));
    expect(result).toEqual({ enforced: true, allowed: false, reason: 'inactive' });
  });

  it('放行付费周期内的账号', async () => {
    const { user, organizationId } = await newSubscriber();
    await seedPaidPeriod(organizationId, { startOffsetDays: -5, endOffsetDays: 25 });
    const result = await access.resolveToolAccess(asSessionUser(user));
    expect(result).toEqual({ enforced: true, allowed: true, reason: 'active' });
  });

  it('付费周期结束后重新拦下', async () => {
    const { user, organizationId } = await newSubscriber();
    await seedPaidPeriod(organizationId, { startOffsetDays: -40, endOffsetDays: -10 });
    const result = await access.resolveToolAccess(asSessionUser(user));
    expect(result.allowed).toBe(false);
  });

  it('还没开始的付费周期不算数（续费不能提前用）', async () => {
    const { user, organizationId } = await newSubscriber();
    await seedPaidPeriod(organizationId, { startOffsetDays: 5, endOffsetDays: 35 });
    const result = await access.resolveToolAccess(asSessionUser(user));
    expect(result.allowed).toBe(false);
  });

  it('被冲正的付费周期不算数', async () => {
    const { user, organizationId } = await newSubscriber();
    await seedPaidPeriod(organizationId, { startOffsetDays: -1, endOffsetDays: 29, status: 'reversed' });
    const result = await access.resolveToolAccess(asSessionUser(user));
    expect(result.allowed).toBe(false);
  });

  it('邮箱白名单按环境变量生效（不区分大小写）', async () => {
    const { user, organizationId } = await newSubscriber();
    expect((await access.resolveToolAccess(asSessionUser(user))).allowed).toBe(false);
    setEnv('SUBSCRIPTION_EXEMPT_EMAILS', ` someone@example.test , ${user.email.toUpperCase()} `);
    expect(await access.resolveToolAccess(asSessionUser(user))).toEqual({
      enforced: true, allowed: true, reason: 'exempt',
    });
    expect(organizationId).toBeTruthy();
  });

  it('应急闸门 off 时全部放行，且不再查库', async () => {
    const { user } = await newSubscriber();
    setEnv('SUBSCRIPTION_ENFORCEMENT', 'off');
    expect(await access.resolveToolAccess(asSessionUser(user))).toEqual({
      enforced: false, allowed: true, reason: 'not_enforced',
    });
  });

  it('支付中心没配置齐全时不拦人', async () => {
    const { user } = await newSubscriber();
    setEnv('PAYMENT_CENTER_API_KEY', '');
    expect(await access.resolveToolAccess(asSessionUser(user))).toEqual({
      enforced: false, allowed: true, reason: 'not_enforced',
    });
  });
});
