import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The referral dashboard surface (plan acceptance criteria 23, 31, 32, 33).
 *
 * `app/[locale]/(dashboard)/dashboard/referrals/page.tsx` cannot be rendered
 * under Vitest: it calls `next-intl/server`, which resolves `next/headers`
 * through a Node `exports` map this Next build does not ship, and the project
 * deliberately has exactly one UI test stack (none). The surface is therefore
 * pinned the way a contract can be pinned without a DOM:
 *
 *  1. every message key the page and the withdrawal sheet reference must exist
 *     in both catalogs, so a locale can never silently lose a label;
 *  2. the accessibility, no-FX and no-full-account rules are assertions over the
 *     real rendered sources (44px targets, ARIA live, reduced motion, masks);
 *  3. the data the page renders comes from `getReferralOverview` against the real
 *     local PostgreSQL with the two external networks mocked by name.
 */
process.env.FEATURE_REFERRALS = 'true';

const require_ = createRequire(import.meta.url);
const { readFile } = require_('node:fs/promises') as {
  readFile: (path: URL, encoding: 'utf8') => Promise<string>;
};
const file = (relative: string) => new URL(relative, import.meta.url);
const PAGE = '../app/[locale]/(dashboard)/dashboard/referrals/page.tsx';
const SHEET = '../components/referrals/withdrawal-form.tsx';
const DISCLOSURE = '../components/referrals/collapsible-section.tsx';
const COPY_FIELD = '../components/referrals/copy-field.tsx';
const ROUTE = '../app/api/referrals/overview/route.ts';

const CATALOGS = {
  'zh-CN': (require_('../messages/zh-CN.json') as {
    Referrals: Record<string, string>; Withdrawal: Record<string, string>;
  }).Referrals,
  en: (require_('../messages/en.json') as {
    Referrals: Record<string, string>; Withdrawal: Record<string, string>;
  }).Referrals,
};
const WITHDRAWAL_CATALOGS = {
  'zh-CN': (require_('../messages/zh-CN.json') as {
    Referrals: Record<string, string>; Withdrawal: Record<string, string>;
  }).Withdrawal,
  en: (require_('../messages/en.json') as {
    Referrals: Record<string, string>; Withdrawal: Record<string, string>;
  }).Withdrawal,
};

/** JSX element tags for interactive elements, brace-aware so `=>` is not a tag end. */
function interactiveTags(source: string): string[] {
  const tags: string[] = [];
  const pattern = /<(a|button|input|select|Link|summary)\b/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    let depth = 0;
    let index = match.index;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
      else if (character === '>' && depth === 0) break;
    }
    tags.push(source.slice(match.index, index + 1));
  }
  return tags;
}

/** Message keys referenced as `t('key')` / `withdrawalText('key')`. */
function referencedKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const match of source.matchAll(/\bt\(\s*'([A-Za-z][A-Za-z0-9]*)'/g)) keys.add(match[1]!);
  for (const match of source.matchAll(/withdrawalText\(\s*'([A-Za-z][A-Za-z0-9]*)'/g)) {
    keys.add(match[1]!);
  }
  return keys;
}

describe('referral surface locale coverage', () => {
  it('labels every string the page and the withdrawal sheet render, in both locales', async () => {
    const sources = await Promise.all([readFile(file(PAGE), 'utf8'), readFile(file(SHEET), 'utf8')]);
    const pageKeys = referencedKeys(sources[0]!);
    const sheetKeys = referencedKeys(sources[1]!);
    expect(pageKeys.size).toBeGreaterThan(20);
    expect(sheetKeys.size).toBeGreaterThan(15);
    // The page reads both namespaces: the row copy from Referrals, the sheet's
    // disabled reasons from Withdrawal.
    for (const key of pageKeys) {
      const catalog = Object.hasOwn(CATALOGS.en, key)
        ? CATALOGS : WITHDRAWAL_CATALOGS;
      for (const [locale, values] of Object.entries(catalog)) {
        expect(typeof values[key], `sheet key ${key} (${locale})`).toBe('string');
        expect(values[key]!.trim().length, `sheet key ${key} (${locale})`).toBeGreaterThan(0);
      }
    }
    for (const key of sheetKeys) {
      for (const [locale, catalog] of Object.entries(WITHDRAWAL_CATALOGS)) {
        expect(typeof catalog[key], `Withdrawal.${key} (${locale})`).toBe('string');
        expect(catalog[key]!.trim().length, `Withdrawal.${key} (${locale})`).toBeGreaterThan(0);
      }
    }
  });

  it('ships the same key set in both locales for the whole referral surface', () => {
    expect(Object.keys(CATALOGS['zh-CN']).sort()).toEqual(Object.keys(CATALOGS.en).sort());
    expect(Object.keys(WITHDRAWAL_CATALOGS['zh-CN']).sort())
      .toEqual(Object.keys(WITHDRAWAL_CATALOGS.en).sort());
  });

  it('covers both languages with real copy rather than one translated and one empty', () => {
    const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
    const chinese = Object.values(CATALOGS['zh-CN']).filter((value) => CJK.test(value)).length;
    // Product names such as "Stripe" stay Latin in both catalogs; everything else
    // must actually be translated.
    expect(chinese / Object.keys(CATALOGS['zh-CN']).length).toBeGreaterThan(0.8);
    for (const [key, value] of Object.entries(CATALOGS.en)) {
      expect(CJK.test(value), `Referrals.${key} en`).toBe(false);
    }
  });
});

describe('referral surface accessibility and privacy (AC 33)', () => {
  it('keeps every interactive target at 44px, including the rule disclosure', async () => {
    const [page, sheet, disclosure, copy] = await Promise.all([
      readFile(file(PAGE), 'utf8'), readFile(file(SHEET), 'utf8'),
      readFile(file(DISCLOSURE), 'utf8'), readFile(file(COPY_FIELD), 'utf8'),
    ]);
    // 44px = Tailwind's min-h-11. Every clickable/typeable element in the surface
    // must carry it, directly or through the shared class constants. 折叠条和复制
    // 按钮搬进客户端组件之后也在这个契约里，不能因为换了文件就漏检。
    for (const [name, source, minimum] of [['page', page, 3], ['sheet', sheet, 3],
      ['disclosure', disclosure, 1], ['copy', copy, 1]] as const) {
      expect(source, name).toContain('min-h-11');
      const tags = interactiveTags(source);
      // 下限只是防止扫描本身空转（扫到 0 个也"全过"）。折叠条和复制按钮搬进
      // 客户端组件后，页面自己只剩分页 <Link>，两个小组件各只有一个按钮。
      expect(tags.length, name).toBeGreaterThanOrEqual(minimum);
      for (const tag of tags) {
        const flat = tag.replace(/\s+/g, ' ');
        expect(flat.includes('min-h-11') || /className=\{(pagerClass|buttonClass)\}/.test(flat),
          `${name}: ${flat.slice(0, 60)}`).toBe(true);
      }
    }
  });

  it('marks the rule panel as expandable instead of relying on a bare triangle', async () => {
    const disclosure = await readFile(file(DISCLOSURE), 'utf8');
    const page = await readFile(file(PAGE), 'utf8');
    // 从原生 <details> 换成受控折叠条：浏览器会替 <details> 恢复 open 状态，
    // 刷新后可能自己摊开，和"默认收起"矛盾。可点性也不再只靠一颗小三角——
    // 右侧有一颗写明「展开/收起」的按钮，标题整行都能点。
    expect(page).toContain('<CollapsibleSection');
    expect(disclosure).toContain('aria-expanded={open}');
    expect(disclosure).toMatch(/useState\(false\)/); // 默认收起
    expect(disclosure).toContain("t('expand')");
    expect(disclosure).toContain("t('collapse')");
    // 箭头随状态转，但转动本身不参与表达信息（读屏读的是「展开/收起」文字）。
    expect(disclosure).toContain('rotate-180');
    expect(disclosure).toContain('aria-hidden="true"');
  });

  it('announces async and error state through ARIA live regions', async () => {
    const sheet = await readFile(file(SHEET), 'utf8');
    // The sheet is the only part of the surface that changes without navigation,
    // so its status text must be announced and its failures must interrupt.
    expect(sheet).toContain('aria-live="polite"');
    expect(sheet).toMatch(/role="status"/);
    expect(sheet).toMatch(/role="alert"/);
    expect(sheet.match(/role="(status|alert)"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Keyboard users must be able to see where focus is.
    expect(sheet.match(/focus-visible:outline-/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });

  it('honours reduced-motion preferences and never relies on motion alone', async () => {
    const [page, sheet] = await Promise.all([
      readFile(file(PAGE), 'utf8'), readFile(file(SHEET), 'utf8'),
    ]);
    for (const [name, source] of [['page', page], ['sheet', sheet]] as const) {
      const animated = [...source.matchAll(/animate-([a-z-]+)/g)]
        .map((match) => match[1]!)
        .filter((name) => name !== 'none');
      for (const animation of animated) {
        expect(source, `${name}: animate-${animation}`).toContain('motion-reduce:animate-none');
      }
    }
  });

  it('never renders a full payout account, a full invitee email or a client-side secret', async () => {
    const [page, sheet] = await Promise.all([
      readFile(file(PAGE), 'utf8'), readFile(file(SHEET), 'utf8'),
    ]);
    // The normal view renders the server mask only.
    expect(sheet).toContain('accountMask');
    expect(sheet).not.toMatch(/payoutAccount\s*}\s*</);
    // No secret or key may be read in a client island.
    expect(sheet).not.toMatch(/process\.env\.[A-Z_]*(SECRET|KEY)/);
    // Invitee rows are masked by the server DTO, never by the view.
    expect(page).not.toMatch(/\.split\('@'\)/);
    expect(page).toContain('invite.email');
  });
});

describe('referral surface data contract (AC 23, 31)', () => {
  it('settles the referral surface in USDT and never converts between currencies', async () => {
    // `overview`, not `module`: the App Router's no-assign-module-variable rule
    // targets the client-module global, and naming an import handle `module`
    // only trips it.
    const overview = await import('@/lib/referrals/overview');
    // 读路径只认 USDT：没有币种参数，也就没有「查出另一个币种视图」的入口。
    expect(overview).not.toHaveProperty('referralCurrency');

    const [page, route] = await Promise.all([
      readFile(file(PAGE), 'utf8'), readFile(file(ROUTE), 'utf8'),
    ]);
    // 返佣只结算 USDT，页面上不再给任何人切币种的入口，也不再读 currency 参数。
    expect(page).not.toMatch(/'USDC'/);
    expect(page).not.toContain('params.currency');
    // 接口同样不读它：调用方带 ?currency= 也只是被忽略。
    expect(route).not.toMatch(/searchParams\.get\(\s*'currency'/);
    // No implicit FX: the amount is rendered from the server decimal string next
    // to the currency code, never through a formatted or converted number.
    expect(page).not.toMatch(/[×*]\s*(rates?|fx|exchange)/i);
    expect(page).not.toMatch(/Intl\.NumberFormat/);
    expect(page).toContain('{displayAmount(entry.amount)} {currency}');
  });

  it('clamps list offsets instead of trusting the query string', async () => {
    const { referralOffset } = await import('@/lib/referrals/overview');
    expect(referralOffset(undefined)).toBe(0);
    expect(referralOffset('0')).toBe(0);
    expect(referralOffset('20')).toBe(20);
    expect(referralOffset('5000')).toBe(5000);
    expect(referralOffset('5001')).toBe(0);
    expect(referralOffset('-20')).toBe(0);
    expect(referralOffset('1.5')).toBe(0);
    expect(referralOffset('abc')).toBe(0);
    expect(referralOffset('1e9')).toBe(0);
    expect(referralOffset('NaN')).toBe(0);
  });

  it('pages without fabricating a total page count', async () => {
    const page = await readFile(file(PAGE), 'utf8');
    // The catalog has no total/page-count label at all, only previous/more.
    expect(Object.keys(CATALOGS.en)).toContain('previous');
    expect(Object.keys(CATALOGS.en)).toContain('more');
    expect(Object.keys(CATALOGS.en).filter((key) => /total|pageCount|pages/i.test(key)))
      .toEqual([]);
    // Links only appear when the server reports another page.
    expect(page).toContain('ledgerHasMore');
    expect(page).toContain('invitationsHaveMore');
    expect(page).toContain('withdrawalsHaveMore');
    expect(page).not.toMatch(/totalPages|pageCount|\.length\s*\/\s*20/);
  });

  it('labels every ledger entry type and every withdrawal status the server can emit', async () => {
    const page = await readFile(file(PAGE), 'utf8');
    const types = ['commission_earned', 'commission_released', 'commission_restored',
      'commission_reversed', 'withdrawal_pending', 'withdrawal_paid', 'withdrawal_rejected',
      'commission_spend', 'commission_spend_refund', 'transfer_out'];
    for (const type of types) expect(page, type).toContain(`case '${type}':`);
    const entryKeys = ['earnedEntry', 'releasedEntry', 'restoredEntry', 'reversedEntry',
      'withdrawalPendingEntry', 'withdrawalPaidEntry', 'withdrawalRejectedEntry', 'spendEntry',
      'spendRefundEntry', 'transferEntry'];
    for (const key of entryKeys) {
      expect(typeof CATALOGS.en[key], key).toBe('string');
      expect(typeof CATALOGS['zh-CN'][key], key).toBe('string');
    }
    // Unrecognised centre values must still render something readable.
    expect(page).toContain('otherEntry');
    expect(page).toContain('unknownStatus');
    const channels = ['STRIPE', 'BINANCE', 'BLOCKCHAIN', 'MANUAL'];
    for (const channel of channels) expect(page, channel).toContain(`case '${channel}':`);
    // 渠道清单是开放列表：收款中心新上的渠道（Binance Pay / OKX Pay 之类）这里
    // 还没有译名，就把标识原样写出来。统一显示「其他渠道」等于把用户往后推。
    expect(page).toMatch(/default: return channel;/);
  });

  it('marks a withdrawal request as retryable only with the same request id', async () => {
    const page = await readFile(file(PAGE), 'utf8');
    const sheet = await readFile(file(SHEET), 'utf8');
    // A recovered request keeps its id and offers the same-id retry, never a new one.
    expect(sheet).toContain("t('requestId'");
    expect(WITHDRAWAL_CATALOGS.en.resultUnknown!.trim().length).toBeGreaterThan(0);
    expect(WITHDRAWAL_CATALOGS.en.retrySame!.trim().length).toBeGreaterThan(0);
    expect(WITHDRAWAL_CATALOGS.en.checkStatus!.trim().length).toBeGreaterThan(0);
    // The sheet stores one request key and reuses it on retry.
    expect(sheet).toContain('saas_referral_withdrawal_request_key');
    expect(sheet).toMatch(/requestKey\.current\s*\|\|\s*crypto\.randomUUID\(\)/);
    // The status list the page renders can be monitored by id as well.
    expect(page).toContain('entry.status');
  });
});

describe('referral overview against the real database (AC 23, 31, 33)', () => {
  const suffix = `w5overview${Date.now().toString(36)}`;
  let fixtures: typeof import('./support/fixtures');
  let overview: typeof import('@/lib/referrals/overview');
  let userId = '';
  let inviteeId = '';
  const created: string[] = [];

  beforeAll(async () => {
    fixtures = await import('./support/fixtures');
    overview = await import('@/lib/referrals/overview');
    const owner = await fixtures.createUserFixture({ suffix, emailVerified: true });
    userId = owner.userId;
    created.push(userId);
    const invitee = await fixtures.createUserFixture({
      suffix: `${suffix}i`, emailVerified: true, marketingOptInRequested: true,
    });
    inviteeId = invitee.userId;
    created.push(inviteeId);
    const client = await fixtures.getClient();
    // The attribution mirror has a database guard binding the stored code to the
    // inviter's real profile, so the fixture must read it instead of inventing one.
    const [profile] = await client`SELECT invite_code FROM referral_profiles
      WHERE user_id = ${userId}`;
    await client`INSERT INTO referral_attributions (user_id, inviter_user_id, invite_code, bound_at)
      VALUES (${inviteeId}, ${userId}, ${profile!.invite_code}, now() - interval '1 hour')`;
    await client`INSERT INTO referral_user_outbox (user_id, event_version, status)
      VALUES (${userId}, 1, 'succeeded')
      ON CONFLICT (user_id, event_version) DO UPDATE SET status = 'succeeded'`;
  });

  afterAll(async () => {
    await fixtures.cleanupFixtures({ userIds: created });
    await fixtures.closeClient();
  });

  /**
   * Payment Center (http://127.0.0.1:5000) stubbed: three read endpoints.
   * The centre always answers in USDT — the read path only ever asks for it —
   * so `balanceCurrency` and `ledgerCurrency` exist purely to make it answer in
   * the wrong one and prove the binding guard refuses it.
   */
  function stubCenter(options: {
    inviteCount?: number;
    ledgerRows?: number;
    withdrawalRows?: number;
    entryType?: string;
    withdrawalStatus?: string;
    withdrawalEnabled?: boolean;
    maintenance?: boolean;
    minimum?: string;
    balanceCurrency?: string;
    ledgerCurrency?: string;
    withdrawalCurrency?: string;
    websiteId?: string;
    rates?: unknown;
    tiers?: unknown;
    tiersFail?: boolean;
  }) {
    const websiteId = options.websiteId ?? process.env.PAYMENT_CENTER_WEBSITE_ID;
    const ledger = Array.from({ length: options.ledgerRows ?? 1 }, (_value, index) => ({
      website_id: websiteId,
      currency: options.ledgerCurrency ?? 'USDT',
      id: `led_${index}`,
      entry_type: options.entryType ?? 'commission_earned',
      amount_decimal: '1.25000000',
      balance_after_decimal: `${index + 1}.25000000`,
      created_at: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    }));
    const withdrawals = Array.from({ length: options.withdrawalRows ?? 0 }, (_value, index) => ({
      website_id: websiteId,
      referral_user_id: `remote_${userId}`,
      currency: options.withdrawalCurrency ?? 'USDT',
      id: `wd_row_${index}`,
      status: options.withdrawalStatus ?? 'paid',
      amount_decimal: '5.00000000',
      requested_at: new Date(Date.UTC(2026, 1, index + 1)).toISOString(),
    }));
    const summary = {
      exists: true,
      user: {
        id: `remote_${userId}`,
        external_user_id: userId,
        website_id: websiteId,
        currency: 'USDT',
      },
      balance: {
        currency: options.balanceCurrency ?? 'USDT',
        available_amount_decimal: '12.50000000',
        verified_available_amount_decimal: '10.00000000',
        pending_amount_decimal: '0.00000000',
        pending_commission_amount_decimal: '1.00000000',
        withdrawn_amount_decimal: '2.00000000',
        total_earned_decimal: '15.50000000',
      },
      invite_count: options.inviteCount ?? 1,
      order_count: 3,
      tier: { name: 'Silver', code: 'silver' },
      next_tier: { name: 'Gold', min_order_count: 10 },
      effective_rates: options.rates ?? [
        { channel: '__personal_default__', commission_rate: 0.15, source: 'tier_rule',
          rule_name: 'Starter', cookie_days: 30 },
        { channel: 'STRIPE', commission_rate: 0.1, source: 'tier_channel_rule',
          rule_name: 'Starter · STRIPE', cookie_days: 30 },
      ],
      maintenance_mode: options.maintenance ?? false,
      withdrawal_enabled: options.withdrawalEnabled ?? true,
      withdrawal_minimum_amount_decimal: options.minimum ?? '10.00000000',
      commission_term_months: 12,
    };
    const calls: string[] = [];
    const send = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
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
      const payload = url.pathname.endsWith('/summary') ? summary
        : url.pathname.endsWith('/ledger') ? { currency: 'USDT', ledger }
          : { currency: 'USDT', withdrawals };
      return new Response(JSON.stringify({ status: 'success', data: payload }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { send, calls };
  }

  it('reports syncing until the referral mirror has been pushed', async () => {
    const client = await fixtures.getClient();
    const fresh = await fixtures.createUserFixture({
      suffix: `${suffix}s`, emailVerified: true, marketingOptInRequested: true,
    });
    created.push(fresh.userId);
    const { send } = stubCenter({});
    expect(await overview.getReferralOverview(fresh.userId, 0, 0, 0, send))
      .toEqual({ state: 'syncing' });
    await client`INSERT INTO referral_user_outbox (user_id, event_version, status)
      VALUES (${fresh.userId}, 1, 'pending')
      ON CONFLICT (user_id, event_version) DO UPDATE SET status = 'pending'`;
    expect(await overview.getReferralOverview(fresh.userId, 0, 0, 0, send))
      .toEqual({ state: 'syncing' });
  });

  it('renders the USDT amount verbatim, with no FX', async () => {
    const { send } = stubCenter({});
    const ready = await overview.getReferralOverview(userId, 0, 0, 0, send);
    if (ready.state !== 'ready') throw new Error(`expected ready, got ${ready.state}`);
    expect(ready.currency).toBe('USDT');
    expect(ready.balance).toEqual({
      available: '12.50000000', verifiedAvailable: '10.00000000', pending: '1.00000000',
      withdrawn: '2.00000000', earned: '15.50000000',
    });
    expect(ready.ledger[0]).toMatchObject({ amount: '1.25000000', currency: 'USDT' });
  });

  it('refuses a center that answers in another currency instead of converting it', async () => {
    // 没有币种参数可传了，唯一剩的防线是：中心回了别的币种就直接拒绝，
    // 而不是把它当成 USDT 摆到钱旁边。余额是页面真正读的字段，它先查。
    for (const wrong of ['USD', 'USDC', 'EUR']) {
      const { send } = stubCenter({ balanceCurrency: wrong });
      await expect(overview.getReferralOverview(userId, 0, 0, 0, send))
        .rejects.toThrow('Referral website or user binding mismatch.');
    }
    const ledger = stubCenter({ ledgerCurrency: 'EUR' });
    await expect(overview.getReferralOverview(userId, 0, 0, 0, ledger.send))
      .rejects.toThrow('Referral ledger binding mismatch.');
    // 提现行的币种只有在真有一行时才会被读到，所以这里要造一行。
    const withdrawals = stubCenter({ withdrawalCurrency: 'USD', withdrawalRows: 1 });
    await expect(overview.getReferralOverview(userId, 0, 0, 0, withdrawals.send))
      .rejects.toThrow('Referral withdrawal binding mismatch.');
    const otherSite = stubCenter({ websiteId: '00000000-0000-4000-8000-000000000000' });
    await expect(overview.getReferralOverview(userId, 0, 0, 0, otherSite.send))
      .rejects.toThrow('Referral website or user binding mismatch.');
  });

  it('takes the invitee list from the local mirror and the count from the center', async () => {
    const { send } = stubCenter({ inviteCount: 7 });
    const ready = await overview.getReferralOverview(userId, 0, 0, 0, send);
    if (ready.state !== 'ready') throw new Error(`expected ready, got ${ready.state}`);
    expect(ready.inviteCount).toBe(7);
    expect(ready.inviteSyncPending).toBe(true);
    expect(ready.invitations).toHaveLength(1);
    expect(ready.invitations[0]!.id).toBe(inviteeId);
    // Local evidence, not the center's number; the email must be masked.
    expect(ready.invitations[0]!.email).toMatch(/^.\*\*\*@/);
    expect(ready.invitations[0]!.email).not.toContain(fixtures.scopedEmail(`${suffix}i`).split('@')[0]!.slice(1));
    expect(ready.inviteCode).toMatch(/^[0-9A-Z]{8}$/);

    const agree = stubCenter({ inviteCount: 1 });
    const matched = await overview.getReferralOverview(userId, 0, 0, 0, agree.send);
    if (matched.state !== 'ready') throw new Error(`expected ready, got ${matched.state}`);
    expect(matched.inviteSyncPending).toBe(false);
  });

  it('asks for one row more than it shows and reports has-more without a total', async () => {
    const { send, calls } = stubCenter({ ledgerRows: 21, withdrawalRows: 21 });
    const ready = await overview.getReferralOverview(userId, 0, 0, 20, send);
    if (ready.state !== 'ready') throw new Error(`expected ready, got ${ready.state}`);
    expect(ready.ledger).toHaveLength(20);
    expect(ready.ledgerHasMore).toBe(true);
    expect(ready.withdrawals).toHaveLength(20);
    expect(ready.withdrawalsHaveMore).toBe(true);
    expect(Object.keys(ready)).not.toContain('total');
    expect(JSON.stringify(ready)).not.toMatch(/"(total|pageCount|totalPages)":/);
    expect(calls.some((call) => call.includes('limit=21'))).toBe(true);
    expect(calls.some((call) => call.includes('offset=20'))).toBe(true);
    expect(calls.some((call) => call.includes('offset=0'))).toBe(true);
  });

  it('exposes maintenance and the minimum so the view can explain a paused withdrawal', async () => {
    const { send } = stubCenter({ maintenance: true, withdrawalEnabled: false,
      minimum: '25.00000000' });
    const ready = await overview.getReferralOverview(userId, 0, 0, 0, send);
    if (ready.state !== 'ready') throw new Error(`expected ready, got ${ready.state}`);
    expect(ready.maintenance).toBe(true);
    expect(ready.withdrawalEnabled).toBe(false);
    expect(ready.withdrawalMinimum).toBe('25.00000000');
    expect(ready.rates).toHaveLength(2);
    expect(ready.rates[0]).toEqual({
      channel: '__personal_default__', rate: 0.15, source: 'tier_rule',
      ruleName: 'Starter', cookieDays: 30,
    });
    expect(ready.nextTier).toEqual({ name: 'Gold', minOrderCount: 10 });
    expect(CATALOGS.en.maintenance.trim().length).toBeGreaterThan(0);
    expect(WITHDRAWAL_CATALOGS.en.insufficient!.trim().length).toBeGreaterThan(0);
    expect(WITHDRAWAL_CATALOGS.en.paused!.trim().length).toBeGreaterThan(0);
  });

  it('carries the caption beside each rate and survives values it has not seen', async () => {
    const { send } = stubCenter({ rates: [
      { channel: 'STRIPE', commission_rate: 0, source: 'brand_new_source', rule_name: 'x' },
      { channel: 'BLOCKCHAIN', commission_rate: 0.4 },
    ] });
    const ready = await overview.getReferralOverview(userId, 0, 0, 0, send);
    if (ready.state !== 'ready') throw new Error(`expected ready, got ${ready.state}`);
    // A zeroed channel stays a number so the view can say "closed" instead of
    // dropping the row; an unfamiliar source or a missing caption is text the
    // page falls back on, never a reason to fail the whole dashboard.
    expect(ready.rates[0]).toEqual({
      channel: 'STRIPE', rate: 0, source: 'brand_new_source', ruleName: 'x', cookieDays: null,
    });
    expect(ready.rates[1]).toEqual({
      channel: 'BLOCKCHAIN', rate: 0.4, source: null, ruleName: null, cookieDays: null,
    });
  });

  it('keeps unknown center entry types and statuses renderable', async () => {
    const { send } = stubCenter({ entryType: 'brand_new_entry',
      withdrawalRows: 1, withdrawalStatus: 'held_by_risk' });
    const ready = await overview.getReferralOverview(userId, 0, 0, 0, send);
    if (ready.state !== 'ready') throw new Error(`expected ready, got ${ready.state}`);
    expect(ready.ledger[0]!.type).toBe('brand_new_entry');
    expect(ready.withdrawals[0]!.status).toBe('held_by_risk');
    // The view maps unknown values through its fallback labels.
    const page = await readFile(file(PAGE), 'utf8');
    expect(page).toContain('otherEntry');
    expect(page).toContain('unknownStatus');
  });

  it('reads the ladder and the commission window the centre publishes', async () => {
    const { send, calls } = stubCenter({});
    const ready = await overview.getReferralOverview(userId, 0, 0, 0, send);
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
    const { send } = stubCenter({ tiersFail: true });
    const ready = await overview.getReferralOverview(userId, 0, 0, 0, send);
    if (ready.state !== 'ready') throw new Error(`expected ready, got ${ready.state}`);
    expect(ready.tiers).toEqual([]);
    // The money surface is unaffected: the balance still comes through.
    expect(ready.balance.available).toBe('12.50000000');
  });

  it('refuses tiers that belong to another website or carry an impossible value', async () => {
    const foreign = stubCenter({ tiers: [
      { website_id: '00000000-0000-4000-8000-000000000000', code: 'gold', name: 'Gold',
        min_order_count: 10, commission_rate: 0.4, cookie_days: 45,
        commission_term_months: 24, priority: 90 },
    ] });
    const foreignReady = await overview.getReferralOverview(userId, 0, 0, 0, foreign.send);
    if (foreignReady.state !== 'ready') throw new Error(`expected ready, got ${foreignReady.state}`);
    expect(foreignReady.tiers).toEqual([]);

    const absurd = stubCenter({ tiers: [
      { website_id: process.env.PAYMENT_CENTER_WEBSITE_ID, code: 'gold', name: 'Gold',
        min_order_count: 10, commission_rate: 7, cookie_days: 45,
        commission_term_months: 24, priority: 90 },
    ] });
    const absurdReady = await overview.getReferralOverview(userId, 0, 0, 0, absurd.send);
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
});

describe('referral tiers and rates (AC 32)', () => {
  it('states the tier, the order count and the next tier with the channel rates', () => {
    for (const key of ['tier', 'unknownTier', 'orders', 'nextTier', 'ratesTitle', 'noRates',
      'stripeChannel', 'binanceChannel', 'blockchainChannel', 'manualChannel', 
      'currentTier', 'currentRate', 'currentRateDescription', 
      'ratesUnavailable', 'ratesUnavailableChannels', 'inviteCode', 'inviteLink', 
      'rulesHint', 'expand', 'collapse', 'copy', 'copied',
      'ratesDescription', 'rateClosed', 'sourceTierChannel', 'sourceTier', 'sourceInviter',
      'sourceMaintenance', 'sourceOther', 'cookieDays', 'tiersTitle', 'tiersDescription',
      'tierHere', 'tierReached', 'tierThreshold', 'tierTerm', 'tierTermUnlimited',
      'tierProgress', 'tierProgressTop', 'rulesTitle', 'rulesCookieTitle', 'rulesCookieBody',
      'rulesTermTitle', 'rulesTermBody', 'rulesTermBodyUnlimited']) {
      expect(typeof CATALOGS.en[key], key).toBe('string');
      expect(typeof CATALOGS['zh-CN'][key], key).toBe('string');
      expect(CATALOGS.en[key]!.trim().length, key).toBeGreaterThan(0);
    }
    // Percentages are formatted from the server rate, not from a copy string.
    expect(CATALOGS.en.ratesTitle).not.toMatch(/\d/);
    expect(CATALOGS.en.stripeChannel).not.toMatch(/\d/);
  });

  it('says why a channel rate is what it is, and marks a zeroed one as closed', async () => {
    const page = await readFile(file(PAGE), 'utf8');
    for (const source of ['inviter_specific_rule', 'inviter_personal_default',
      'user_legacy_override', 'tier_channel_rule', 'tier_rule', 'maintenance_mode']) {
      expect(page, source).toContain(`case '${source}':`);
    }
    expect(page).toContain('rateClosed');
    expect(page).toContain('line-through');
    expect(page).toContain('entry.ruleName');
    // Cookie 是等级属性，四个渠道永远同值；阶梯显示一次，渠道行不再重复。
    expect(page).toContain('overview.tiers');
    // 整页只允许出现一处 Cookie 天数：阶梯那一处。
    expect(page.match(/t\('cookieDays'/g)?.length).toBe(1);
    // The future-default row repeats the tier caption, so the view drops it the
    // way AutoTrading does instead of listing a channel nobody pays yet.
    expect(page).toContain("entry.channel !== '__personal_default__'");
  });

  it('shows the whole ladder, the progress and the two rule explanations', async () => {
    const page = await readFile(file(PAGE), 'utf8');
    expect(page).toContain('<CollapsibleSection');
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

  it('offers both payout rails as cards before anything is typed', async () => {
    const sheet = await readFile(file(SHEET), 'utf8');
    expect(sheet).toContain("setMethod('BINANCE_UID')");
    expect(sheet).toContain("setMethod('BLOCKCHAIN')");
    expect(sheet).toContain("t('uidHint')");
    expect(sheet).toContain("t('addressHint')");
    // The browser checks the same shapes the server enforces.
    expect(sheet).toContain("'[0-9]{5,20}'");
    expect(sheet).toContain("'0x[0-9a-fA-F]{40}'");
  });

  it('offers the invite toolkit with a single derived invite link', async () => {
    const page = await readFile(file(PAGE), 'utf8');
    expect(page).toContain('/invite/');
    expect(page).toContain('APP_BASE_URL');
    for (const key of ['inviteTitle', 'inviteCount', 'inviteSyncPending', 'inviteHistory',
      'noInvites', 'previous', 'more']) {
      expect(typeof CATALOGS.en[key], key).toBe('string');
    }
  });
});
