import { requireCapability } from '@/lib/config';
import { client } from '@/lib/db/drizzle';
import { enabledMethods, getPaymentCatalog } from '@/lib/payment-center/catalog';

const pageSize = 20;

/**
 * 收款中心的付款方式 → 返佣渠道标识。
 *
 * 渠道清单是**开放列表**：收款中心随时能上一个新渠道（Binance Pay、OKX Pay
 * 都是后加的），站点这边写死一份名单就必然落后一步——新渠道能收钱、返佣页却
 * 看不见它，用户以为这个渠道白给。所以这里按规则推导而不是枚举：
 * 大写、去掉结尾的 `_pay`。
 *
 * `commission_balance`（佣金余额付款）花的是自己已经赚到的佣金，不会再给
 * 上级产生分润，所以不计入渠道表。
 */
const NO_COMMISSION_METHODS = new Set(['commission_balance']);

export function channelForPaymentMethod(method: unknown): string | null {
  const normalized = String(method ?? '').trim().toLowerCase();
  if (!normalized || NO_COMMISSION_METHODS.has(normalized)) return null;
  const channel = normalized.replace(/_pay$/, '').replace(/[^a-z0-9]+/g, '_').toUpperCase();
  return channel && channel.length <= 30 ? channel : null;
}

/** 目录里能收钱的付款方式 → 返佣渠道（保持目录顺序，重复项只留一次）。 */
export function channelsForMethods(methods: readonly string[]): string[] {
  const channels: string[] = [];
  for (const method of methods) {
    const channel = channelForPaymentMethod(method);
    if (channel && !channels.includes(channel)) channels.push(channel);
  }
  return channels;
}

/**
 * 返佣只结算 USDT：提现走 Binance UID / 区块链地址，收付两端都是 USDT。
 * 这里刻意不留币种参数——留下就有人能查出别的币种视图，而那个视图里的钱
 * 既不参与结算、也不许提现，摆出来只会让人误会。
 */
const currency = 'USDT' as const;

export function referralOffset(value: string | undefined): number {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 && number <= 5_000 ? number : 0;
}

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

function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)(\.\d{1,8})?$/.test(value)) {
    throw new Error('Invalid Payment Center amount.');
  }
  return value;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('Invalid Payment Center count.');
  }
  return Number(value);
}

function rate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Invalid Payment Center referral rate.');
  }
  return value;
}

function cookieDays(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 3650
    ? Number(value) : null;
}

function months(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 120
    ? Number(value) : null;
}

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!name || !domain) return '***';
  return `${name.slice(0, 1)}***@${domain}`;
}

async function getRemote(path: string, send: typeof fetch) {
  const url = new URL(path, process.env.PAYMENT_CENTER_BASE_URL);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Insecure Payment Center URL.');
  }
  const response = await send(url, {
    headers: { 'X-API-Key': process.env.PAYMENT_CENTER_REFERRAL_API_KEY! },
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('Payment Center referral lookup failed.');
  const body = await response.json() as { status?: string; data?: unknown };
  if (body.status !== 'success' || !body.data || typeof body.data !== 'object') {
    throw new Error('Invalid Payment Center referral response.');
  }
  return body.data as Record<string, unknown>;
}

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

export async function getReferralOverview(
  userId: string,
  ledgerOffset = 0,
  inviteOffset = 0,
  withdrawalOffset = 0,
  send: typeof fetch = fetch,
) {
  requireCapability('referrals');
  const [profile] = await client`
    SELECT p.invite_code, (
      SELECT status::text FROM referral_user_outbox
      WHERE user_id = p.user_id ORDER BY event_version DESC LIMIT 1
    ) AS sync_status
    FROM referral_profiles p WHERE p.user_id = ${userId}
  `;
  if (!profile || profile.sync_status !== 'succeeded') {
    return { state: 'syncing' as const };
  }

  const path = `/api/referral-center/users/${encodeURIComponent(userId)}`;
  const [summary, ledgerPage, withdrawalPage, invitations, inviteTotals, tiers, channelList] = await Promise.all([
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
    // 收款中心**当下开着**哪些付款方式。返佣中心只为它自己认识的渠道出比例，
    // 新渠道（比如刚上线的 OKX Pay）不会出现在 effective_rates 里——不读目录，
    // 页面上就永远少一格。
    //
    // 拿不到目录（中心没开、网络断了）返回 null：这时**一条渠道都不许列**。
    // 收款那边此刻是「没接上」，返佣这边却照旧报几个渠道和比例，等于给了个
    // 没人兑现的价目表。宁可明说读不到，也不拿旧数字凑数。
    getPaymentCatalog(send)
      .then((catalog) => ({
        enabled: channelsForMethods(enabledMethods(catalog)),
        // 开着但当下连不上的（币安/OKX 流水读不到）：不列进表，单独说一声。
        unavailable: channelsForMethods(
          Object.keys(catalog.unavailable_methods).filter((method) => catalog.methods.includes(method))),
      }))
      .catch(() => null),
  ]);
  const channels = channelList;
  const enabledChannels = channels ? channels.enabled : null;
  const unavailableChannels = channels ? channels.unavailable : [];
  const remoteUser = summary.user as Record<string, unknown> | undefined;
  const balance = summary.balance as Record<string, unknown> | undefined;
  if (summary.exists !== true || remoteUser?.external_user_id !== userId ||
      remoteUser.website_id !== process.env.PAYMENT_CENTER_WEBSITE_ID ||
      balance?.currency !== currency || ledgerPage.currency !== currency ||
      withdrawalPage.currency !== currency || !Array.isArray(ledgerPage.ledger) ||
      !Array.isArray(withdrawalPage.withdrawals) || typeof remoteUser.id !== 'string') {
    throw new Error('Referral website or user binding mismatch.');
  }

  const ledger = ledgerPage.ledger.slice(0, pageSize).map((item: unknown) => {
    const row = item as Record<string, unknown>;
    if (row.website_id !== process.env.PAYMENT_CENTER_WEBSITE_ID ||
        row.currency !== currency || typeof row.id !== 'string' ||
        typeof row.entry_type !== 'string' || typeof row.created_at !== 'string') {
      throw new Error('Referral ledger binding mismatch.');
    }
    return {
      id: row.id,
      type: row.entry_type,
      amount: decimal(row.amount_decimal),
      balanceAfter: decimal(row.balance_after_decimal),
      currency,
      at: row.created_at,
    };
  });
  const withdrawals = withdrawalPage.withdrawals.slice(0, pageSize).map((item: unknown) => {
    const row = item as Record<string, unknown>;
    if (row.website_id !== process.env.PAYMENT_CENTER_WEBSITE_ID ||
        row.referral_user_id !== remoteUser.id || row.currency !== currency ||
        typeof row.id !== 'string' || typeof row.status !== 'string' ||
        typeof row.requested_at !== 'string') {
      throw new Error('Referral withdrawal binding mismatch.');
    }
    return {
      id: row.id,
      status: row.status,
      amount: decimal(row.amount_decimal),
      currency,
      at: row.requested_at,
    };
  });
  if (!Array.isArray(summary.effective_rates)) {
    throw new Error('Invalid Payment Center referral rates.');
  }
  // 渠道标识只校验**形状**，不校验具体是哪几个：清单归收款中心所有，它加一个
  // 新渠道不该让整页返佣数据作废（那样用户看到的是「暂时无法查询」，比少一格更难懂）。
  const rates = summary.effective_rates.map((item: unknown) => {
    const row = item as Record<string, unknown>;
    // 大小写都放行：`__personal_default__` 是中心给的小写占位行，真实渠道是大写。
    if (typeof row.channel !== 'string' || !/^[A-Za-z0-9_]{1,30}$/.test(row.channel)) {
      throw new Error('Invalid referral channel.');
    }
    // The rate is money and is validated strictly; the labels beside it are
    // presentational, so an unfamiliar source or rule name is carried through as
    // null and the view falls back to a generic caption instead of blanking the
    // whole dashboard over copy it has never seen.
    const source = typeof row.source === 'string' && row.source.trim()
      ? row.source.trim().slice(0, 60) : null;
    const ruleName = typeof row.rule_name === 'string' && row.rule_name.trim()
      ? row.rule_name.trim().slice(0, 80) : null;
    return { channel: String(row.channel), rate: rate(row.commission_rate), source, ruleName,
      cookieDays: cookieDays(row.cookie_days) };
  });
  const summaryTier = summary.tier as Record<string, unknown> | undefined;
  const tierName = typeof summaryTier?.name === 'string' ? String(summaryTier.name) : null;
  const tierCode = typeof summaryTier?.code === 'string' && summaryTier.code.trim()
    ? summaryTier.code.trim().slice(0, 40) : null;
  const nextTier = summary.next_tier as Record<string, unknown> | null | undefined;
  if (nextTier && (typeof nextTier.name !== 'string' ||
      !Number.isSafeInteger(nextTier.min_order_count))) {
    throw new Error('Invalid next referral tier.');
  }

  return {
    state: 'ready' as const,
    currency,
    balance: {
      available: decimal(balance.available_amount_decimal),
      verifiedAvailable: decimal(balance.verified_available_amount_decimal),
      // The centre holds a card commission until its Stripe hold window
      // elapses; that frozen money sits in `pending_commission_amount`.
      // `pending_amount` is a different bucket — withdrawals being processed,
      // always zero while withdrawals are disabled — and reading it made a
      // held commission look like it never arrived.
      pending: decimal(balance.pending_commission_amount_decimal),
      withdrawn: decimal(balance.withdrawn_amount_decimal),
      earned: decimal(balance.total_earned_decimal),
    },
    inviteCount: count(summary.invite_count),
    inviteSyncPending: count(summary.invite_count) !== count(inviteTotals[0]?.count),
    orderCount: count(summary.order_count),
    tier: tierName,
    tierCode,
    nextTier: nextTier ? { name: String(nextTier.name), minOrderCount: count(nextTier.min_order_count) } : null,
    tiers,
    commissionTermMonths: months(summary.commission_term_months),
    rates,
    // null = 目录没拿到（收款那边没接上），页面不列渠道。
    enabledChannels,
    /** 开着但当下连不上的渠道：不列表格，只在旁边提一句。 */
    unavailableChannels,
    maintenance: summary.maintenance_mode === true,
    withdrawalEnabled: summary.withdrawal_enabled === true,
    withdrawalMinimum: decimal(summary.withdrawal_minimum_amount_decimal),
    inviteCode: String(profile.invite_code),
    ledger,
    ledgerHasMore: ledgerPage.ledger.length > pageSize,
    withdrawals,
    withdrawalsHaveMore: withdrawalPage.withdrawals.length > pageSize,
    invitations: invitations.slice(0, pageSize).map((row) => ({
      id: String(row.user_id),
      email: maskEmail(String(row.email)),
      at: new Date(row.bound_at).toISOString(),
    })),
    invitationsHaveMore: invitations.length > pageSize,
  };
}
