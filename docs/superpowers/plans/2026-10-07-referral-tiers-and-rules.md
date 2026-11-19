# 返佣等级阶梯与规则说明 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 SaaS Framework 的返佣页显示完整等级阶梯（门槛／比例／Cookie／返佣期限）、当前进度和两段返佣规则说明，数据全部实时取自 Payment Center。

**Architecture:** 只改 `saas-framework`。取数层 `lib/referrals/overview.ts` 在已有的 `Promise.all` 里**并行**增加一次 `GET /api/referral-center/tiers`，并补读 `summary.commission_term_months`；`/tiers` 任何失败都降级为空数组，页面退回现有的一行 `next_tier` 提示，不影响余额与提现。展示层在提现表单与渠道比例之间插入一张等级阶梯卡片，卡片底部是一个原生 `<details>` 折叠的规则说明。

**Tech Stack:** Next.js（本项目为改写版，写代码前先读 `node_modules/next/dist/docs/`）、TypeScript strict、next-intl、Vitest、Tailwind。

**Spec:** `docs/superpowers/specs/2026-10-07-referral-tiers-and-rules-design.md`

---

## 背景：执行者需要知道的事

- **payment-center 零改动。** 所需数据全部已在现有只读接口里，现有 `PAYMENT_CENTER_REFERRAL_API_KEY` 已具备 `referral_read` 权限，无需新密钥。
- **本地环境已经跑起来了**：payment-center 在 `http://127.0.0.1:5000`，saas-framework 在 `http://localhost:3000`，PostgreSQL 在 `127.0.0.1:5432`。
- **真实浏览器验证用的账号**：`chrome-sync-test@example.test` / `LocalReferralSmoke123!`（Advanced 等级，7 笔有效订单，四个渠道各 40%）。这个账号的密码是为本次验证临时设置的。
- **本项目测试的全部约束**（来自 `tests/referral-ui.test.ts`，改动必须同时满足）：
  1. 页面里每个 `t('key')` 引用的词条必须在中英两份 catalog 里都存在；
  2. 两份 catalog 的键集合必须**完全相同**；
  3. zh-CN 里 >80% 的词条必须含中日韩字符，en 里**一个都不许有**（判定范围 `㐀-䶿一-鿿＀-￯`，em dash U+2014 不在范围内，安全）；
  4. 每个 `<a|button|input|select|Link|summary>` 交互元素必须带 `min-h-11`（44px 触控目标）;
  5. `animate-*` 必须配 `motion-reduce:animate-none`——本次不引入任何动画。
- **不要动** `tests/referral-contract.test.ts`、`tests/withdrawal.test.ts`，它们与本次改动无关。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `messages/zh-CN.json` | 修改 | `Referrals` 命名空间新增 15 个中文词条 |
| `messages/en.json` | 修改 | `Referrals` 命名空间新增同名的 15 个英文词条 |
| `lib/referrals/overview.ts` | 修改 | 解析返佣期限、并行拉取等级阶梯、导出纯函数 `tierPositions` |
| `app/[locale]/(dashboard)/dashboard/referrals/page.tsx` | 修改 | 渲染等级阶梯卡片与规则说明折叠面板，去掉渠道行重复的 Cookie |
| `tests/referral-ui.test.ts` | 修改 | 覆盖以上全部行为 |

---

### Task 1: 中英词条

**Files:**
- Modify: `messages/zh-CN.json:359`（`Referrals` 块内，`cookieDays` 之后）
- Modify: `messages/en.json:359`（`Referrals` 块内，`cookieDays` 之后）
- Test: `tests/referral-ui.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `tests/referral-ui.test.ts` 里找到 `describe('referral tiers and rates (AC 32)')` 的第一个 `it`，把它的 key 列表从

```ts
    for (const key of ['tier', 'unknownTier', 'orders', 'nextTier', 'ratesTitle', 'noRates',
      'stripeChannel', 'binanceChannel', 'blockchainChannel', 'manualChannel', 'defaultChannel',
      'ratesDescription', 'rateClosed', 'sourceTierChannel', 'sourceTier', 'sourceInviter',
      'sourceMaintenance', 'sourceOther', 'cookieDays']) {
```

改成

```ts
    for (const key of ['tier', 'unknownTier', 'orders', 'nextTier', 'ratesTitle', 'noRates',
      'stripeChannel', 'binanceChannel', 'blockchainChannel', 'manualChannel', 'defaultChannel',
      'ratesDescription', 'rateClosed', 'sourceTierChannel', 'sourceTier', 'sourceInviter',
      'sourceMaintenance', 'sourceOther', 'cookieDays', 'tiersTitle', 'tiersDescription',
      'tierHere', 'tierReached', 'tierThreshold', 'tierTerm', 'tierTermUnlimited',
      'tierProgress', 'tierProgressTop', 'rulesTitle', 'rulesCookieTitle', 'rulesCookieBody',
      'rulesTermTitle', 'rulesTermBody', 'rulesTermBodyUnlimited']) {
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/referral-ui.test.ts -t "states the tier, the order count and the next tier"`
Expected: FAIL —— `tiersTitle` 在中英两侧都不是 string。

- [ ] **Step 3: 写实现**

在 `messages/zh-CN.json` 的 `Referrals` 块里，`"cookieDays": "Cookie {days} 天",` 这一行**之后**插入：

```json
    "tiersTitle": "等级与升级条件",
    "tiersDescription": "等级由有效订单数自动决定；升级后所有渠道的比例、Cookie 和返佣期限一起生效。",
    "tierHere": "你在这里",
    "tierReached": "已达成",
    "tierThreshold": "{count} 单起",
    "tierTerm": "返佣 {months} 个月",
    "tierTermUnlimited": "返佣不限期限",
    "tierProgress": "已 {count} 笔有效订单，距 {tier} 还差 {remaining} 笔",
    "tierProgressTop": "已 {count} 笔有效订单，已是最高等级",
    "rulesTitle": "返佣规则说明",
    "rulesCookieTitle": "Cookie 是什么？",
    "rulesCookieBody": "它只管「点邀请链接 → 注册」这一段：Cookie 有效期内点过你链接的人，注册后就算你邀请的。绑定一旦记进数据库就是永久的——Cookie 过期只影响还没注册的新访客，已经绑定的人不受影响。",
    "rulesTermTitle": "返佣能拿多久？",
    "rulesTermBody": "从每位客户的「首笔已确认付款」那天起算，按自然月计算，你当前等级是 {months} 个月。到期后这位客户再下单不再产生佣金，但已经发给你的佣金不会被收回。",
    "rulesTermBodyUnlimited": "你当前的等级不限返佣期限，绑定客户产生的每笔订单都会计佣。",
```

在 `messages/en.json` 的 `Referrals` 块里，`"cookieDays": "Cookie {days} days",` 这一行**之后**插入：

```json
    "tiersTitle": "Tiers and upgrade conditions",
    "tiersDescription": "Your tier follows your qualified order count. Moving up moves every channel's rate, cookie window and commission window with it.",
    "tierHere": "You are here",
    "tierReached": "Reached",
    "tierThreshold": "{count}+ orders",
    "tierTerm": "{months}-month commission window",
    "tierTermUnlimited": "No commission time limit",
    "tierProgress": "{count} qualified orders, {remaining} more to reach {tier}",
    "tierProgressTop": "{count} qualified orders, you are on the highest tier",
    "rulesTitle": "How commissions work",
    "rulesCookieTitle": "What is the cookie for?",
    "rulesCookieBody": "The cookie only covers the step from clicking your invite link to signing up. Someone who opens your link while it is valid is credited to you when they register. A binding is permanent once recorded: an expired cookie only stops new visitors from being credited to you, and never releases people already bound.",
    "rulesTermTitle": "How long do I keep earning?",
    "rulesTermBody": "Counted in calendar months from each customer's first confirmed payment. Your current tier earns for {months} months. After that, new orders from that customer stop earning commission, but commission already paid to you is never taken back.",
    "rulesTermBodyUnlimited": "Your current tier has no commission time limit, so every order from a customer bound to you earns commission.",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/referral-ui.test.ts`
Expected: PASS —— 含 `ships the same key set in both locales` 与 `covers both languages with real copy` 两条。

- [ ] **Step 5: 提交**

```bash
git add messages/zh-CN.json messages/en.json tests/referral-ui.test.ts
git commit -m "feat(referrals): add tier ladder and rule explanation copy"
```

---

### Task 2: 取数层——返佣期限与等级阶梯

**Files:**
- Modify: `lib/referrals/overview.ts`
- Test: `tests/referral-ui.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `tests/referral-ui.test.ts` 的 `stubCenter` 入参类型里，`rates?: unknown;` 之后加两行：

```ts
    tiers?: unknown;
    tiersFail?: boolean;
```

在 `stubCenter` 的 `summary` 常量里改两处：把 `tier: { name: 'Silver' },` 改成 `tier: { name: 'Silver', code: 'silver' },`，并在 `withdrawal_minimum_amount_decimal: options.minimum ?? '10.00000000',` 之后加一行：

```ts
      commission_term_months: 12,
```

在 `stubCenter` 的 `send` 里，把

```ts
      const payload = url.pathname.endsWith('/summary') ? summary
```

之前插入 `/tiers` 分支：

```ts
      if (url.pathname.endsWith('/tiers')) {
        if (options.tiersFail) throw new Error('Simulated Payment Center outage');
        return new Response(JSON.stringify({
          status: 'success',
          data: {
            tiers: options.tiers ?? [
              { website_id: websiteId, code: 'silver', name: 'Silver',
                min_order_count: 0, commission_rate: 0.2, cookie_days: 30,
                commission_term_months: 12, priority: 100, is_active: true },
              { website_id: websiteId, code: 'gold', name: 'Gold',
                min_order_count: 10, commission_rate: 0.4, cookie_days: 45,
                commission_term_months: 24, priority: 90, is_active: true },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
```

在 `describe('referral tiers and rates (AC 32)')` 里，"states the tier..." 那个 `it` 之后追加三个新 `it`：

```ts
  it('reads the ladder and the commission window the centre publishes', async () => {
    const { send, calls } = stubCenter({ currency: 'USDT' });
    const ready = await overview.getReferralOverview(userId, 'USDT', 0, 0, 0, send);
    if (ready.state !== 'ready') throw new Error(`expected ready, got ${ready.state}`);
    expect(ready.tierCode).toBe('silver');
    expect(ready.commissionTermMonths).toBe(12);
    expect(ready.tiers).toEqual([
      { code: 'silver', name: 'Silver', minOrderCount: 0, commissionRate: 0.2,
        cookieDays: 30, commissionTermMonths: 12, priority: 100 },
      { code: 'gold', name: 'Gold', minOrderCount: 10, commissionRate: 0.4,
        cookieDays: 45, commissionTermMonths: 24, priority: 90 },
    ]);
    expect(calls.some((call) => call === '/api/referral-center/tiers')).toBe(true);
  });

  it('drops the ladder instead of the dashboard when the centre cannot list tiers', async () => {
    const { send } = stubCenter({ currency: 'USDT', tiersFail: true });
    const ready = await overview.getReferralOverview(userId, 'USDT', 0, 0, 0, send);
    if (ready.state !== 'ready') throw new Error(`expected ready, got ${ready.state}`);
    expect(ready.tiers).toEqual([]);
    // The money surface is unaffected: the balance still comes through.
    expect(ready.balance.available).toBe('12.50000000');
  });

  it('refuses tiers that belong to another website or carry an impossible value', async () => {
    const foreign = stubCenter({ currency: 'USDT', tiers: [
      { website_id: '00000000-0000-4000-8000-000000000000', code: 'gold', name: 'Gold',
        min_order_count: 10, commission_rate: 0.4, cookie_days: 45,
        commission_term_months: 24, priority: 90 },
    ] });
    const foreignReady = await overview.getReferralOverview(userId, 'USDT', 0, 0, 0, foreign.send);
    if (foreignReady.state !== 'ready') throw new Error(`expected ready, got ${foreignReady.state}`);
    expect(foreignReady.tiers).toEqual([]);

    const absurd = stubCenter({ currency: 'USDT', tiers: [
      { website_id: process.env.PAYMENT_CENTER_WEBSITE_ID, code: 'gold', name: 'Gold',
        min_order_count: 10, commission_rate: 7, cookie_days: 45,
        commission_term_months: 24, priority: 90 },
    ] });
    const absurdReady = await overview.getReferralOverview(userId, 'USDT', 0, 0, 0, absurd.send);
    if (absurdReady.state !== 'ready') throw new Error(`expected ready, got ${absurdReady.state}`);
    expect(absurdReady.tiers).toEqual([]);
  });

  it('marks the active row and the next row of the ladder', () => {
    const ladder = [
      { code: 'silver', name: 'Silver', minOrderCount: 0, commissionRate: 0.2,
        cookieDays: 30, commissionTermMonths: 12, priority: 100 },
      { code: 'gold', name: 'Gold', minOrderCount: 3, commissionRate: 0.4,
        cookieDays: 45, commissionTermMonths: 12, priority: 90 },
      { code: 'expert', name: 'Expert', minOrderCount: 10, commissionRate: 0.5,
        cookieDays: 60, commissionTermMonths: 24, priority: 80 },
    ];
    // The centre's code is the truth when it is present.
    expect(overview.tierPositions(ladder, 'gold', 7)).toEqual({ active: 1, next: 2 });
    // An older summary without a code falls back to the centre's own rule.
    expect(overview.tierPositions(ladder, null, 7)).toEqual({ active: 1, next: 2 });
    expect(overview.tierPositions(ladder, null, 0)).toEqual({ active: 0, next: 1 });
    // On the top tier there is nothing to upgrade to.
    expect(overview.tierPositions(ladder, null, 99)).toEqual({ active: 2, next: -1 });
    expect(overview.tierPositions([], null, 3)).toEqual({ active: -1, next: -1 });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/referral-ui.test.ts -t "reads the ladder"`
Expected: FAIL —— `ready.tiers` 是 `undefined`。

- [ ] **Step 3: 写实现**

在 `lib/referrals/overview.ts` 里，`export function referralOffset` 之后插入类型与纯函数：

```ts
export type ReferralTier = {
  code: string;
  name: string;
  minOrderCount: number;
  commissionRate: number;
  cookieDays: number;
  /** `0` 是不限期限；`null` 是中心没给或给了非法值，界面隐藏期限文案。 */
  commissionTermMonths: number | null;
  priority: number;
};

/**
 * 阶梯里「你在这里」和「下一级」分别是第几行。中心已经给出等级 code，按它匹配
 * 就是事实；旧版 summary 没有 code 时，退化为重复中心自己 get_current_tier 的
 * 规则——门槛已满足的里面取最高的那一级，同门槛时 priority 小的赢。
 * 两级都返回 `-1` 表示没有对应行（空阶梯，或已在最高级）。
 */
export function tierPositions(
  tiers: readonly ReferralTier[],
  tierCode: string | null,
  orderCount: number,
): { active: number; next: number } {
  const byCode = tiers.findIndex((entry) => tierCode !== null && entry.code === tierCode);
  const active = byCode >= 0 ? byCode : tiers.reduce((best, entry, index) => {
    if (entry.minOrderCount > orderCount) return best;
    const chosen = best >= 0 ? tiers[best] : undefined;
    if (!chosen || entry.minOrderCount > chosen.minOrderCount
        || (entry.minOrderCount === chosen.minOrderCount && entry.priority < chosen.priority)) {
      return index;
    }
    return best;
  }, -1);
  return { active, next: tiers.findIndex((entry) => entry.minOrderCount > orderCount) };
}
```

在 `function rate(value: unknown)` 之后插入两个字段校验器：

```ts
function cookieDays(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 3650
    ? Number(value) : null;
}

function months(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 120
    ? Number(value) : null;
}
```

在 `async function getRemote` 之后插入阶梯取数：

```ts
/**
 * 全部启用中的等级。任何一行不像话（别人的网站、比例越界、门槛为负）就让整段
 * 阶梯作废——宁可退回一行提示，也不把猜出来的数字摆到钱旁边。
 */
async function getReferralTiers(send: typeof fetch): Promise<ReferralTier[]> {
  const data = await getRemote('/api/referral-center/tiers', send);
  if (!Array.isArray(data.tiers)) throw new Error('Invalid Payment Center tier list.');
  return data.tiers.map((item: unknown) => {
    const row = item as Record<string, unknown>;
    const days = cookieDays(row.cookie_days);
    if (row.website_id !== process.env.PAYMENT_CENTER_WEBSITE_ID ||
        typeof row.code !== 'string' || !row.code.trim() ||
        typeof row.name !== 'string' || !row.name.trim() ||
        !Number.isSafeInteger(row.min_order_count) || Number(row.min_order_count) < 0 ||
        !Number.isSafeInteger(row.priority) || days === null) {
      throw new Error('Payment Center tier binding mismatch.');
    }
    return {
      code: row.code.trim().slice(0, 40),
      name: row.name.trim().slice(0, 80),
      minOrderCount: Number(row.min_order_count),
      commissionRate: rate(row.commission_rate),
      cookieDays: days,
      commissionTermMonths: months(row.commission_term_months),
      priority: Number(row.priority),
    };
  });
}
```

把 `getReferralOverview` 里的 `Promise.all` 改成六项——把 `getReferralTiers(send).catch(() => [])` 放在**最后**，并同步解构：

```ts
  const [summary, ledgerPage, withdrawalPage, invitations, inviteTotals, tiers] = await Promise.all([
    getRemote(`${path}/summary?currency=${currency}`, send),
    getRemote(`${path}/ledger?currency=${currency}&limit=${pageSize + 1}&offset=${ledgerOffset}`, send),
    getRemote(`/api/referral-center/withdrawals?external_user_id=${encodeURIComponent(userId)}&currency=${currency}&limit=${pageSize + 1}&offset=${withdrawalOffset}`, send),
    client`
      SELECT a.user_id, a.bound_at, u.email
      FROM referral_attributions a JOIN "user" u ON u.id = a.user_id
      WHERE a.inviter_user_id = ${userId}
      ORDER BY a.bound_at DESC, a.user_id DESC
      LIMIT ${pageSize + 1} OFFSET ${inviteOffset}
    `,
    client`SELECT COUNT(*)::integer AS count FROM referral_attributions WHERE inviter_user_id = ${userId}`,
    // 一条辅助列表不该让余额和提现一起不可用：这里吞掉失败，页面退回一行提示。
    getReferralTiers(send).catch(() => [] as ReferralTier[]),
  ]);
```

把 rates 映射里那段手写的 cookie 校验换成校验器：

```ts
    const cookieDays = Number.isSafeInteger(row.cookie_days) && Number(row.cookie_days) >= 0
      && Number(row.cookie_days) <= 3650 ? Number(row.cookie_days) : null;
```

整段删除，改为在返回对象里写 `cookieDays: cookieDays(row.cookie_days),`。

把 `const nextTier = summary.next_tier as Record<string, unknown> | null | undefined;` 之前插入当前等级的解析：

```ts
  const summaryTier = summary.tier as Record<string, unknown> | undefined;
  const tierName = typeof summaryTier?.name === 'string' ? String(summaryTier.name) : null;
  const tierCode = typeof summaryTier?.code === 'string' && summaryTier.code.trim()
    ? summaryTier.code.trim().slice(0, 40) : null;
```

在返回对象里，把

```ts
    tier: typeof (summary.tier as Record<string, unknown> | undefined)?.name === 'string'
      ? String((summary.tier as Record<string, unknown>).name) : null,
    nextTier: nextTier ? { name: String(nextTier.name), minOrderCount: count(nextTier.min_order_count) } : null,
    rates,
```

改成

```ts
    tier: tierName,
    tierCode,
    nextTier: nextTier ? { name: String(nextTier.name), minOrderCount: count(nextTier.min_order_count) } : null,
    tiers,
    commissionTermMonths: months(summary.commission_term_months),
    rates,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/referral-ui.test.ts`
Expected: PASS（含原有的 `exposes maintenance and the minimum` 与 `carries the caption beside each rate`，它们断言的是精确对象，不能被新增字段破坏）。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无输出（通过）。

- [ ] **Step 6: 提交**

```bash
git add lib/referrals/overview.ts tests/referral-ui.test.ts
git commit -m "feat(referrals): read the tier ladder and commission window from Payment Center"
```

---

### Task 3: 页面——等级阶梯卡片与规则说明

**Files:**
- Modify: `app/[locale]/(dashboard)/dashboard/referrals/page.tsx`
- Test: `tests/referral-ui.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `tests/referral-ui.test.ts` 里，把 `interactiveTags` 的扫描范围加上 `summary`：

```ts
  const pattern = /<(a|button|input|select|Link)\b/g;
```

改成

```ts
  const pattern = /<(a|button|input|select|Link|summary)\b/g;
```

在 `describe('referral tiers and rates (AC 32)')` 里，"says why a channel rate is what it is..." 那个 `it` 里，把

```ts
    expect(page).toContain("t('cookieDays', { days: entry.cookieDays })");
```

改成

```ts
    // Cookie 是等级属性，四个渠道永远同值；阶梯显示一次，渠道行不再重复。
    expect(page).toContain('overview.tiers');
    // 整页只允许出现一处 Cookie 天数：阶梯那一处。
    expect(page.match(/t\('cookieDays'/g)?.length).toBe(1);
```

在 `describe('referral tiers and rates (AC 32)')` 末尾追加一个新的 `it`：

```ts
  it('shows the whole ladder, the progress and the two rule explanations', async () => {
    const page = await readFile(file(PAGE), 'utf8');
    expect(page).toContain('<details');
    expect(page).toContain('<summary');
    expect(page).toContain('tierPositions');
    for (const key of ['tierHere', 'tierReached', 'tierThreshold', 'tierProgress',
      'tierProgressTop', 'tierTerm', 'tierTermUnlimited']) {
      expect(page).toContain(`t('${key}'`);
    }
    expect(page).toContain("t('rulesTitle')");
    expect(page).toContain("t('rulesCookieTitle')");
    expect(page).toContain("t('rulesCookieBody')");
    expect(page).toContain("t('rulesTermTitle')");
    // 期限为 0 是无限制，为 null 是中心没给，两者不能混为一谈。
    expect(page).toContain("t('rulesTermBodyUnlimited')");
    expect(page).toContain("t('rulesTermBody', { months: currentTerm })");
    // 阶梯为空时退回已有的下一级提示，而不是让整张卡片消失。
    expect(page).toContain("t('nextTier'");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/referral-ui.test.ts -t "shows the whole ladder"`
Expected: FAIL —— 页面里还没有 `<details`。

- [ ] **Step 3: 写实现**

在 `app/[locale]/(dashboard)/dashboard/referrals/page.tsx` 里，把 import 补上 `tierPositions`：

```ts
import { getReferralOverview, referralCurrency, referralOffset, tierPositions } from '@/lib/referrals/overview';
```

把 header 卡片里这三行**删掉**（进度改由阶梯卡片负责）：

```tsx
      {overview.nextTier && <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
        {t('nextTier', { tier: overview.nextTier.name,
          count: Math.max(0, overview.nextTier.minOrderCount - overview.orderCount) })}
      </p>}
```

在 `const rateRows = overview.rates.filter(...)` 之后插入：

```tsx
  // 期限有三种意思：数字是月数，0 是不限，null 是中心没给——界面要区别对待。
  const termLabel = (value: number | null) => value === null ? null
    : value === 0 ? t('tierTermUnlimited') : t('tierTerm', { months: value });
  const position = tierPositions(overview.tiers, overview.tierCode, overview.orderCount);
  const activeTier = position.active >= 0 ? overview.tiers[position.active] : undefined;
  const upcomingTier = position.next >= 0 ? overview.tiers[position.next] : undefined;
  const currentTerm = activeTier?.commissionTermMonths ?? overview.commissionTermMonths;
  const termParagraph = currentTerm === null ? null
    : currentTerm === 0 ? t('rulesTermBodyUnlimited')
    : t('rulesTermBody', { months: currentTerm });
```

在 `<WithdrawalForm ... />` 与「当前渠道返佣比例」那张 `<section>` **之间**插入新卡片：

```tsx
    {overview.tiers.length ? <section className="rounded-xl border bg-white p-8 dark:border-gray-700 dark:bg-gray-900">
      <h2 className="text-xl font-semibold">{t('tiersTitle')}</h2>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{t('tiersDescription')}</p>
      <ul className="mt-4 grid gap-3">
        {overview.tiers.map((entry, index) => {
          const current = index === position.active;
          const passed = entry.minOrderCount <= overview.orderCount;
          const term = termLabel(entry.commissionTermMonths);
          const muted = current ? 'text-gray-300 dark:text-gray-600' : 'text-gray-500 dark:text-gray-400';
          return <li key={entry.code} className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg p-4 text-sm ${current ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-950' : passed ? 'bg-gray-100 dark:bg-gray-800' : 'bg-gray-50 dark:bg-gray-800'}`}>
            <span>
              <span className="font-medium">{entry.name}</span>
              <span className={`ml-2 text-xs ${muted}`}>{t('tierThreshold', { count: entry.minOrderCount })}</span>
            </span>
            <span className="text-right">
              <strong className="tabular-nums">{percent(entry.commissionRate)}</strong>
              <span className={`mt-1 block text-xs ${muted}`}>
                {t('cookieDays', { days: entry.cookieDays })}{term !== null && ` · ${term}`}
              </span>
            </span>
            {current
              ? <span className="rounded-full border border-white/40 px-2 py-0.5 text-xs dark:border-gray-900/40">{t('tierHere')}</span>
              : passed && <span className="rounded-full border px-2 py-0.5 text-xs">{t('tierReached')}</span>}
          </li>;
        })}
      </ul>
      <p className="mt-4 text-sm text-gray-600 dark:text-gray-300">
        {upcomingTier
          ? t('tierProgress', { count: overview.orderCount, tier: upcomingTier.name,
              remaining: Math.max(0, upcomingTier.minOrderCount - overview.orderCount) })
          : t('tierProgressTop', { count: overview.orderCount })}
      </p>
      <details className="mt-6 border-t pt-4 dark:border-gray-700">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-600 dark:focus-visible:outline-gray-300">{t('rulesTitle')}</summary>
        <div className="mt-3 space-y-4 text-sm text-gray-600 dark:text-gray-300">
          <div>
            <h3 className="font-medium text-gray-900 dark:text-gray-100">{t('rulesCookieTitle')}</h3>
            <p className="mt-1 leading-6">{t('rulesCookieBody')}</p>
          </div>
          {termParagraph !== null && <div>
            <h3 className="font-medium text-gray-900 dark:text-gray-100">{t('rulesTermTitle')}</h3>
            <p className="mt-1 leading-6">{termParagraph}</p>
          </div>}
        </div>
      </details>
    </section> : overview.nextTier ? <section className="rounded-xl border bg-white p-8 dark:border-gray-700 dark:bg-gray-900">
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t('nextTier', { tier: overview.nextTier.name,
          count: Math.max(0, overview.nextTier.minOrderCount - overview.orderCount) })}
      </p>
    </section> : null}
```

把渠道比例卡片里的来源行改成不含 Cookie：

```tsx
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                {sourceLabel(entry.source)}
                {entry.cookieDays !== null && ` · ${t('cookieDays', { days: entry.cookieDays })}`}
              </span>
```

改成

```tsx
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">{sourceLabel(entry.source)}</span>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/referral-ui.test.ts`
Expected: PASS（含 44px 触控目标那条——它现在也扫描 `<summary>`）。

- [ ] **Step 5: lint 与类型检查**

Run: `npm run lint && npm run typecheck`
Expected: 两者都无输出。

- [ ] **Step 6: 提交**

```bash
git add "app/[locale]/(dashboard)/dashboard/referrals/page.tsx" tests/referral-ui.test.ts
git commit -m "feat(referrals): show the tier ladder, progress and rule explanations"
```

---

### Task 4: 全量测试与真实浏览器验证

**Files:** 无源码改动；失败时回到对应 Task 修。

- [ ] **Step 1: 跑全量单元测试**

Run: `npm test`
Expected: 全部 PASS。若 `tests/i18n.test.ts` 报出 catalog 键集合不一致，说明 Task 1 只改了一份文件。

- [ ] **Step 2: 真实浏览器验证（按 CLAUDE.md，必须真开页面）**

两个服务已在跑：payment-center `http://127.0.0.1:5000`，saas-framework `http://localhost:3000`。

1. 用 Chrome DevTools 打开 `http://localhost:3000/zh-CN/sign-in`，用 `chrome-sync-test@example.test` / `LocalReferralSmoke123!` 登录（Turnstile 是测试钥匙，自动通过）。
2. 进入 `http://localhost:3000/zh-CN/dashboard/referrals`。
3. 对照 Payment Center 后台（`http://127.0.0.1:5000/referral-center/rules`）核对：
   - 阶梯必须列出 Starter（0 单／20%／Cookie 30 天／返佣 12 个月）、Advanced（3 单／40%／45 天／12 个月）、Expert（10 单／50%／60 天／24 个月）；
   - Advanced 行高亮并显示「你在这里」，Starter 行显示「已达成」；
   - 进度行显示「已 7 笔有效订单，距 Expert 还差 3 笔」；
   - 四个渠道行**只剩**「渠道名／比例／等级渠道设置」，不再出现 Cookie。
4. **真点一下**「返佣规则说明」，确认展开出两段文案，且第二段写的是「12 个月」。
5. 截图留档，并把「改动前 / 改动后」两张图给用户对比。

- [ ] **Step 3: 验证降级路径**

把 saas-framework 的 `.env` 里 `PAYMENT_CENTER_BASE_URL` 临时改成 `http://127.0.0.1:5999`（无服务），重启 dev server，重开返佣页：应看到整页显示「暂时无法查询返佣数据」——**这是现状行为，不是本次引入的**。

更好的降级验证是只让 `/tiers` 失败，这已由 Task 2 的 `drops the ladder instead of the dashboard` 单测覆盖，不必手工制造。

改回 `http://127.0.0.1:5000` 并重启 dev server。

- [ ] **Step 4: 英文界面复核**

把浏览器语言切到 English 再看一遍同一个页面，确认没有中文残留、没有排版溢出。**这一步是必须的**，因为 `tests/referral-ui.test.ts` 会拒绝英文词条里出现中日韩字符，但排版溢出它管不了。

- [ ] **Step 5: 提交（若有修正）**

```bash
git add -A
git commit -m "test(referrals): verify the ladder in a real browser"
```

---

## 收尾备注

- payment-center 全程未改，无需重启它以外的任何操作。
- 验证用的 `chrome-sync-test@example.test` 密码是本次为浏览器验证临时设置的；这个账号是自动化测试造的，不是真实用户。
- 计划与设计文档的关系：设计文档写「为什么」，本计划写「怎么做」。若执行中发现设计有误，先改设计文档再改代码。
