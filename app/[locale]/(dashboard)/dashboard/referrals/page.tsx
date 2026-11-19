import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { Link } from '@/i18n/navigation';
import { auth } from '@/lib/auth';
import { getCapabilities } from '@/lib/config';
import { getReferralOverview, referralOffset, tierPositions } from '@/lib/referrals/overview';
import WithdrawalForm from '@/components/referrals/withdrawal-form';
import CollapsibleSection from '@/components/referrals/collapsible-section';
import CopyField from '@/components/referrals/copy-field';

export const dynamic = 'force-dynamic';

function displayAmount(value: string) {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

function minorUnits(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
}

/**
 * The withdrawal form is only offered to a session that was established
 * recently. `Date.now()` is deliberately called from a helper rather than in
 * the component body: reading the clock during render is an impure operation,
 * and keeping it in a named function makes the rule and the reason explicit.
 */
function recentLogin(createdAt: string | Date, now = Date.now()) {
  return now - new Date(createdAt).getTime() <= 15 * 60_000;
}

const CARD = 'rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900';
const MUTED = 'text-gray-600 dark:text-gray-300';

export default async function ReferralsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('Referrals');
  const withdrawalText = await getTranslations('Withdrawal');
  const locale = await getLocale();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  if (!getCapabilities().referrals.configured) {
    return <section className={`${CARD} p-8`}>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className={`mt-3 ${MUTED}`}>{t('unconfigured')}</p>
    </section>;
  }
  const params = await searchParams;
  const first = (value: string | string[] | undefined) =>
    typeof value === 'string' ? value : undefined;
  // 返佣只结算 USDT：提现走 Binance UID / 区块链地址，收付两端都是 USDT，
  // 不给页面留切换币种的入口。取数层同样只认 USDT，这里只管显示。
  const currency = 'USDT' as const;
  const ledgerOffset = referralOffset(first(params.ledgerOffset));
  const inviteOffset = referralOffset(first(params.inviteOffset));
  const withdrawalOffset = referralOffset(first(params.withdrawalOffset));
  let overview;
  try {
    overview = await getReferralOverview(session.user.id, ledgerOffset, inviteOffset, withdrawalOffset);
  } catch {
    return <section className={`${CARD} p-8`}>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className={`mt-3 ${MUTED}`}>{t('unavailable')}</p>
    </section>;
  }
  if (overview.state === 'syncing') {
    return <section className={`${CARD} p-8`}>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className={`mt-3 ${MUTED}`}>{t('syncing')}</p>
    </section>;
  }

  const pageHref = (nextLedger: number, nextInvites: number, nextWithdrawals: number) =>
    `/dashboard/referrals?ledgerOffset=${nextLedger}&inviteOffset=${nextInvites}&withdrawalOffset=${nextWithdrawals}`;
  const inviteUrl = `${process.env.APP_BASE_URL!.replace(/\/$/, '')}/${locale}/invite/${overview.inviteCode}`;
  const pagerClass = 'inline-flex min-h-11 items-center underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-600 dark:focus-visible:outline-gray-300';
  const typeLabel = (type: string) => {
    switch (type) {
      case 'commission_earned': return t('earnedEntry');
      case 'commission_released': return t('releasedEntry');
      case 'commission_restored': return t('restoredEntry');
      case 'commission_reversed': return t('reversedEntry');
      case 'withdrawal_pending': return t('withdrawalPendingEntry');
      case 'withdrawal_paid': return t('withdrawalPaidEntry');
      case 'withdrawal_rejected': return t('withdrawalRejectedEntry');
      case 'commission_spend': return t('spendEntry');
      case 'commission_spend_refund': return t('spendRefundEntry');
      case 'transfer_out': return t('transferEntry');
      default: return t('otherEntry');
    }
  };
  const channelLabel = (channel: string) => {
    switch (channel) {
      case 'STRIPE': return t('stripeChannel');
      case 'BINANCE': return t('binanceChannel');
      case 'BLOCKCHAIN': return t('blockchainChannel');
      case 'MANUAL': return t('manualChannel');
      // 渠道清单是开放列表：收款中心新上的渠道这里还没有译名，就把标识原样写出来，
      // 总比统一显示「其他渠道」强——用户至少知道是哪个渠道的比例。
      default: return channel;
    }
  };
  const percent = (value: number) => `${Number((value * 100).toFixed(4))}%`;
  const sourceLabel = (source: string | null) => {
    switch (source) {
      case 'inviter_specific_rule':
      case 'inviter_personal_default':
      case 'user_legacy_override': return t('sourceInviter');
      case 'tier_channel_rule': return t('sourceTierChannel');
      case 'tier_rule': return t('sourceTier');
      case 'maintenance_mode': return t('sourceMaintenance');
      default: return t('sourceOther');
    }
  };
  // The centre also returns a "__personal_default__" row for channels it has not
  // seen yet. Like AutoTrading, the dashboard lists the real channels only; the
  // fallback row would otherwise repeat the tier caption under a name nobody pays.
  const rateRows = overview.rates.filter((entry) => entry.channel !== '__personal_default__');
  // "当前分润比例" = 等级默认那一行；中心没给就退回当前等级自身的比例。
  const personalDefault = overview.rates.find((entry) => entry.channel === '__personal_default__');
  const position = tierPositions(overview.tiers, overview.tierCode, overview.orderCount);
  const activeTier = position.active >= 0 ? overview.tiers[position.active] : undefined;
  const upcomingTier = position.next >= 0 ? overview.tiers[position.next] : undefined;
  const currentRate = personalDefault?.rate ?? activeTier?.commissionRate ?? null;
  const currentRateSource = personalDefault?.source ?? 'tier_rule';
  /*
    渠道表以**收款中心目录**为准：目录里开着的付款方式一条不落，返佣中心只为
    它认识的渠道出比例，新渠道（后加的 Binance Pay / OKX Pay 之类）就用当前
    等级的默认比例兜底——先让它出现，比例随后台规则同步。

    目录拿不到（null）时**一条都不列**：那一刻收款那边也是"没接上"，这里再摆
    几个渠道和比例，就是拿一张没人兑现的价目表哄人。只留一句"读不到"。
  */
  const channels = overview.enabledChannels;
  const channelRows = (channels ?? []).map((channel) => rateRows.find((entry) => entry.channel === channel) ?? {
    channel, rate: currentRate ?? 0, source: 'tier_rule', ruleName: null, cookieDays: null,
  });
  // 期限有三种意思：数字是月数，0 是不限，null 是中心没给——界面要区别对待。
  const termLabel = (value: number | null) => value === null ? null
    : value === 0 ? t('tierTermUnlimited') : t('tierTerm', { months: value });
  const currentTerm = activeTier?.commissionTermMonths ?? overview.commissionTermMonths;
  const termParagraph = currentTerm === null ? null
    : currentTerm === 0 ? t('rulesTermBodyUnlimited')
    : t('rulesTermBody', { months: currentTerm });
  const sessionIsFresh = recentLogin(session.session.createdAt);
  const withdrawalDisabled = currency !== 'USDT' ? withdrawalText('usdtOnly')
    : !getCapabilities().referralWithdrawals.configured ? withdrawalText('unavailable')
    : !session.user.emailVerified ? withdrawalText('confirmEmail')
    : !sessionIsFresh ? withdrawalText('signInAgain')
    : !overview.withdrawalEnabled || overview.maintenance ? withdrawalText('paused')
    : minorUnits(overview.balance.verifiedAvailable) <= 0n ||
      minorUnits(overview.balance.verifiedAvailable) < minorUnits(overview.withdrawalMinimum)
      ? withdrawalText('insufficient') : null;

  return <div className="space-y-6">
    {/* 我的邀请信息 — 放最上面：先给邀请码、链接，再给等级和比例 */}
    <section className={`overflow-hidden ${CARD}`}>
      <div className="px-6 pt-6 sm:px-8 sm:pt-8">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className={`mt-2 text-sm ${MUTED}`}>{t('description')}</p>
        {overview.maintenance && <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">{t('maintenance')}</p>}

        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <CopyField label={t('inviteCode')} value={overview.inviteCode} size="large" />
          <div className="lg:col-span-2">
            <CopyField label={t('inviteLink')} value={inviteUrl} />
          </div>
        </div>
        <p className={`mt-2 text-sm ${MUTED}`}>{t('inviteCount', { count: overview.inviteCount })}</p>
        {overview.inviteSyncPending && <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">{t('inviteSyncPending')}</p>}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-xs tracking-wide text-gray-500 uppercase dark:text-gray-400">{t('currentTier')}</p>
            <p className="mt-1 text-lg font-semibold">{overview.tier || t('unknownTier')}</p>
            <p className={`mt-1 text-sm ${MUTED}`}>{t('orders', { count: overview.orderCount })}</p>
            {upcomingTier && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('nextTier', { tier: upcomingTier.name,
                count: Math.max(0, upcomingTier.minOrderCount - overview.orderCount) })}
            </p>}
          </div>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-xs tracking-wide text-gray-500 uppercase dark:text-gray-400">{t('currentRate')}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {currentRate === null ? '—' : percent(currentRate)}
            </p>
            <p className={`mt-1 text-sm ${MUTED}`}>{t('currentRateDescription')}</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{sourceLabel(currentRateSource)}</p>
          </div>
        </div>
      </div>

      {/* 等级与升级条件 — 等级表来自返佣中心，当前等级直接高亮 */}
      {overview.tiers.length ? <div className="mt-6">
        <div className="border-t border-gray-200 px-6 py-4 dark:border-gray-700 sm:px-8">
          <h2 className="font-semibold">{t('tiersTitle')}</h2>
          <p className={`mt-1 text-sm ${MUTED}`}>{t('tiersDescription')}</p>
        </div>
        <ul>
          {overview.tiers.map((entry, index) => {
            const current = index === position.active;
            const passed = !current && entry.minOrderCount <= overview.orderCount;
            const term = termLabel(entry.commissionTermMonths);
            const muted = current ? 'text-gray-300 dark:text-gray-600' : 'text-gray-500 dark:text-gray-400';
            return <li key={entry.code}
              className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-gray-200 px-6 py-4 text-sm dark:border-gray-700 sm:px-8 ${current ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-950' : 'bg-gray-50 dark:bg-gray-800'}`}>
              <span className="flex items-baseline gap-2">
                <span className="font-medium">{entry.name}</span>
                <span className={`text-xs ${muted}`}>{t('tierThreshold', { count: entry.minOrderCount })}</span>
                {current && <span className="rounded-full border border-white/40 px-2 py-0.5 text-xs dark:border-gray-900/40">{t('tierHere')}</span>}
                {passed && <span className="rounded-full border px-2 py-0.5 text-xs">{t('tierReached')}</span>}
              </span>
              <span className="text-right">
                <strong className="tabular-nums">{percent(entry.commissionRate)}</strong>
                <span className={`mt-1 block text-xs ${muted}`}>
                  {t('cookieDays', { days: entry.cookieDays })}{term !== null && ` · ${term}`}
                </span>
              </span>
            </li>;
          })}
        </ul>
        <p className={`border-t border-gray-200 px-6 py-3 text-sm dark:border-gray-700 sm:px-8 ${MUTED}`}>
          {upcomingTier
            ? t('tierProgress', { count: overview.orderCount, tier: upcomingTier.name,
                remaining: Math.max(0, upcomingTier.minOrderCount - overview.orderCount) })
            : t('tierProgressTop', { count: overview.orderCount })}
        </p>
        {/* 返佣规则说明 — 默认收起，标题和右侧按钮都明说"这里能点开" */}
        <CollapsibleSection title={t('rulesTitle')} hint={t('rulesHint')}>
          <div className={`space-y-4 text-sm ${MUTED}`}>
            <div>
              <h3 className="font-medium text-gray-900 dark:text-gray-100">{t('rulesCookieTitle')}</h3>
              <p className="mt-1 leading-6">{t('rulesCookieBody')}</p>
            </div>
            {termParagraph !== null && <div>
              <h3 className="font-medium text-gray-900 dark:text-gray-100">{t('rulesTermTitle')}</h3>
              <p className="mt-1 leading-6">{termParagraph}</p>
            </div>}
          </div>
        </CollapsibleSection>
      </div> : overview.nextTier ? <div className={`mt-6 border-t border-gray-200 px-6 py-4 text-sm dark:border-gray-700 sm:px-8 ${MUTED}`}>
        {t('nextTier', { tier: overview.nextTier.name,
          count: Math.max(0, upcomingTier ? 0 : overview.nextTier.minOrderCount - overview.orderCount) })}
      </div> : null}

      {/* 各渠道分润比例 — 默认收起；渠道清单跟着收款中心走 */}
      <div className="mt-6">
        <CollapsibleSection title={t('ratesTitle')} hint={t('ratesDescription')}
          count={channels ? channelRows.length : undefined}>
          {channels === null ? <p className={`text-sm ${MUTED}`}>{t('ratesUnavailable')}</p>
          : channelRows.length ? <ul className="grid gap-3 sm:grid-cols-2">
            {channelRows.map((entry) => {
              const closed = entry.rate === 0;
              return <li key={entry.channel}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm dark:border-gray-700 dark:bg-gray-800">
                <span className="min-w-0">
                  <span className="font-medium">{channelLabel(entry.channel)}</span>
                  <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">{entry.channel}</span>
                  {entry.ruleName && <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">{entry.ruleName}</span>}
                </span>
                <span className="text-right">
                  <strong className={`tabular-nums ${closed ? 'text-gray-500 line-through dark:text-gray-400' : ''}`}>{percent(entry.rate)}</strong>
                  {closed && <span className="ml-2 rounded-full border border-red-300 px-2 py-0.5 text-xs text-red-700 dark:border-red-700 dark:text-red-300">{t('rateClosed')}</span>}
                  {/* Cookie 是等级属性，四个渠道永远同值；阶梯上显示一次就够了，
                      渠道行不再重复。 */}
                  <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">{sourceLabel(entry.source)}</span>
                </span>
              </li>;
            })}
          </ul> : <p className={`text-sm ${MUTED}`}>{t('noRates')}</p>}
          {/* 开着但当下连不上的渠道：不列表格（付不了钱就没有佣金），但要说明白，
              不然用户会以为站点把它漏掉了。 */}
          {channels !== null && overview.unavailableChannels.length > 0 &&
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              {t('ratesUnavailableChannels', {
                names: overview.unavailableChannels.map(channelLabel).join('、'),
              })}
            </p>}
        </CollapsibleSection>
      </div>
    </section>

    <section className={`${CARD} p-6 sm:p-8`}>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {([
          [t('available'), overview.balance.available],
          [t('pending'), overview.balance.pending],
          [t('earned'), overview.balance.earned],
          [t('withdrawn'), overview.balance.withdrawn],
        ] as const).map(([label, value]) => <div key={label} className="rounded-lg bg-gray-50 p-4 dark:bg-gray-800">
          <p className={`text-sm ${MUTED}`}>{label}</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{displayAmount(value)} {currency}</p>
        </div>)}
      </div>
    </section>

    <WithdrawalForm available={displayAmount(overview.balance.verifiedAvailable)}
      minimum={displayAmount(overview.withdrawalMinimum)} disabledReason={withdrawalDisabled} />

    <div className="grid gap-6 lg:grid-cols-2">
      <section className={`${CARD} p-6 sm:p-8`}>
        <h2 className="text-xl font-semibold">{t('ledgerTitle')}</h2>
        {overview.ledger.length ? <ul className="mt-4 divide-y divide-gray-200 dark:divide-gray-700">
          {overview.ledger.map((entry) => <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3 text-sm">
            <div><p className="font-medium">{typeLabel(entry.type)}</p>
              <time className="text-gray-500 dark:text-gray-400" dateTime={entry.at}>{new Date(entry.at).toLocaleString(locale)}</time></div>
            <p className="tabular-nums">{displayAmount(entry.amount)} {currency}</p>
          </li>)}
        </ul> : <p className={`mt-4 text-sm ${MUTED}`}>{t('noLedger')}</p>}
        <div className="mt-4 flex gap-4 text-sm">
          {ledgerOffset > 0 && <Link className={pagerClass} href={pageHref(Math.max(0, ledgerOffset - 20), inviteOffset, withdrawalOffset)}>{t('previous')}</Link>}
          {overview.ledgerHasMore && <Link className={pagerClass} href={pageHref(ledgerOffset + 20, inviteOffset, withdrawalOffset)}>{t('more')}</Link>}
        </div>
      </section>

      <section className={`${CARD} p-6 sm:p-8`}>
        <h2 className="text-xl font-semibold">{t('withdrawalTitle')}</h2>
        {overview.withdrawals.length ? <ul className="mt-4 divide-y divide-gray-200 dark:divide-gray-700">
          {overview.withdrawals.map((entry) => <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3 text-sm">
            <div><p className="font-medium">{t(['requested', 'approved', 'paid', 'rejected'].includes(entry.status) ?
              entry.status as 'requested' | 'approved' | 'paid' | 'rejected' : 'unknownStatus')}</p>
              <time className="text-gray-500 dark:text-gray-400" dateTime={entry.at}>{new Date(entry.at).toLocaleString(locale)}</time></div>
            <p className="tabular-nums">{displayAmount(entry.amount)} {currency}</p>
          </li>)}
        </ul> : <p className={`mt-4 text-sm ${MUTED}`}>{t('noWithdrawals')}</p>}
        <div className="mt-4 flex gap-4 text-sm">
          {withdrawalOffset > 0 && <Link className={pagerClass} href={pageHref(ledgerOffset, inviteOffset, Math.max(0, withdrawalOffset - 20))}>{t('previous')}</Link>}
          {overview.withdrawalsHaveMore && <Link className={pagerClass} href={pageHref(ledgerOffset, inviteOffset, withdrawalOffset + 20)}>{t('more')}</Link>}
        </div>
      </section>
    </div>

    <section className={`${CARD} p-6 sm:p-8`}>
      <h2 className="text-xl font-semibold">{t('inviteHistory')}</h2>
      {overview.invitations.length ? <ul className="mt-4 divide-y divide-gray-200 dark:divide-gray-700">
        {overview.invitations.map((invite) => <li key={invite.id} className="flex justify-between gap-4 py-3 text-sm">
          <span>{invite.email}</span><time dateTime={invite.at}>{new Date(invite.at).toLocaleDateString(locale)}</time>
        </li>)}
      </ul> : <p className={`mt-4 text-sm ${MUTED}`}>{t('noInvites')}</p>}
      <div className="mt-4 flex gap-4 text-sm">
        {inviteOffset > 0 && <Link className={pagerClass} href={pageHref(ledgerOffset, Math.max(0, inviteOffset - 20), withdrawalOffset)}>{t('previous')}</Link>}
        {overview.invitationsHaveMore && <Link className={pagerClass} href={pageHref(ledgerOffset, inviteOffset + 20, withdrawalOffset)}>{t('more')}</Link>}
      </div>
    </section>
  </div>;
}
