# 跨渠道购买：付费期内用任何渠道再买

## 目标

客户已经在用 Stripe 自动续费，照样允许他用别的渠道（区块链 / 手动 / 佣金余额）付钱。
两种买法都放行：

- **续同一套餐** —— 时间接在当前到期日之后，Stripe 不动，该扣照扣、扣了就继续加时间；
- **换成别的套餐** —— 剩余时间按两边的月价比折算，旧套餐的 Stripe 自动续费在付款成功后**自动关掉**。

付款前必须在页面上**明确告诉客户**这两件事分别会发生什么，让他自己决定。

**只改 `saas-framework`。`payment-center` 零改动** —— Stripe 订阅接口（查状态、开关自动续费）
已经存在并被账单页使用，这次只是多一个调用者，不需要新的中心接口。

## 背景：原来为什么买不了

客户先用 Stripe 开了套餐，Stripe 每月自动扣款。某天他打开定价页想用别的渠道再买，页面回他：
「你的账户还在付费期内，续费可以等当前账期结束后再买。」

这道墙的来历：预付费渠道买到的是一段**固定长度的时间**，跟 Stripe 那种每月自动续的订阅不是
一回事。如果一段新时间直接盖在已有的付费期上，就是同一段时间收了两次钱。所以当初一刀切：
只要还在付费期内，预付费渠道一律不卖。

一刀切挡对了「重复卖同一段时间」，但把「接着往后买」和「换个套餐」也一起挡掉了。

## 设计决策

| # | 决策 | 依据 |
|---|---|---|
| D1 | 付费期内，任何渠道都可以买**同一套餐**，时间接在最新到期日之后 | 用户核心诉求 |
| D2 | 同套餐叠加时，Stripe 的自动续费**不推后、不关闭**；扣款成功继续往到期日后加时间 | 用户原话：「他再扣一次钱也没有关系啊。因为如果成功扣款了，就把日期往上加不就行了吗？」 |
| D3 | 任何渠道都可以**换套餐**，剩余时间按 `proratePlanSwitch` 折算 | 用户原话：「换套餐用什么渠道，只要他付了钱，他怎么换都无所谓啊」 |
| D4 | 换套餐走非 Stripe 渠道时，**自动取消**原 Stripe 订阅的自动续费 | 用户明确要求；旧订阅继续扣款会为一个没人用的套餐付费 |
| D5 | 付款窗口显示提醒，**不放关闭按钮**，只引导客户去账单页自己关 | 用户原话：「这个提醒就好了，让客户去账单里面关」 |
| D6 | 不做「成功后自动取消其他渠道」，除 D4 那一种 | 用户早前明确「先不加」 |

## 实现

### 一、放开四道「有付费期就拒单」的闸门

这四处原先只看「有没有付费期」，不看买的是什么。全部删除 —— 续期和换套餐现在都有正确的
落点（见下两节），没有需要在这里拒绝的情形：

| 文件 | 原行为 |
|---|---|
| `lib/billing/intents.ts` | 预付费渠道 + 有付费期 → 抛 `paid_period_exists` |
| `lib/billing/submit.ts` | 同上（提交前那道） |
| `lib/billing/submit.ts` | 同上（并发路径那道，抛之前还 `finishClaim(..., 'paid_period_exists')`） |
| `lib/billing/commission-preparation.ts` | 佣金余额预留前，有付费期 → 抛 `CommissionPreparationConflict` |

连带清理：

- `PaymentIntentConflictCode` 只剩 `'pending_checkout'`（`pending_checkout` 仍然是真拒绝：
  同一渠道有未完成订单）；
- `app/api/payment-center/checkout/route.ts` 的 `paid_period_exists` 分支和
  「你的账户还在付费期内」文案一并删掉；
- `hasUnexpiredPaidPeriod` 函数本身保留（`tests/payment-center-contract.test.ts` 在测它），
  只是不再有人拦单。

### 二、预付费也接在现有到期日之后

`lib/subscription/service.ts` 里，`running`（当前最新的未过期 grant）原先被
`providerSubscriptionId` 挡着 —— 只有 Stripe 订阅才查：

```ts
const [running] = providerSubscriptionId ? await tx.select(...) : [];
```

**去掉这个三元**，任何渠道都查。`continuationPeriod(period, running?.periodEnd ?? null)`
会把中心返回的时段挪到现有到期日之后；`running` 为空（已过期或首次购买）时保持原样。

为什么原来只给 Stripe 拼：预付费渠道根本进不来，永远不会有重叠，拼接对它没有意义。
现在它进得来了，两边行为就一致了。

### 三、换套餐的折算：把买的那一期加回来

`proratePlanSwitch`（`lib/billing/intents.ts`）在下单时算出一段天数：
「剩余天数 × 旧套餐月价 ÷ 新套餐月价」，存进 `payment_intents.prorated_period_end`。

**它描述的是「折算出来的那一截」到哪个时刻，不是最终到期日。** 客户这次付钱还买了新套餐
的一整期，两者要相加。原来的代码把折算值**当成了**最终到期日，于是客户买了一个月的新套餐，
却只拿到折算出来的十几天。

`lib/subscription/service.ts` 改成：

```ts
const convertedSeconds = intent.proratedPeriodEnd
  ? Math.floor(intent.proratedPeriodEnd.getTime() / 1000) - Math.floor(period.settledAt)
  : 0;
const span = intent.proratedPeriodEnd
  ? { start: period.servicePeriodStart, end: period.servicePeriodEnd + convertedSeconds }
  : continuationPeriod(period, running?.periodEnd ?? null);
```

折算路径下旧 grant 会被撤销（原先就有），新 grant 独占生效期。

### 四、换套餐时取消被取代的 Stripe 自动续费

**两处配合，缺一不可。**

**判定**（`lib/subscription/service.ts`）：`fulfillSubscription` 现在返回 `planSwitched`：

```ts
const planSwitched = Boolean(intent.proratedPeriodEnd) ||
  Boolean(running && running.productCode !== intent.productCode);
```

用两个条件是因为 **`proratedPeriodEnd` 为空也可能是换套餐**：剩余时间折完不足一天
（`convertedDays <= 0`）或目录里缺月付价时，`proratePlanSwitch` 返回 `undefined`，这时
买卖照做，新套餐接在旧套餐到期日之后（「甲案」）。这种也算换套餐，旧订阅一样要关。

重放（`duplicate: true`）恒为 `false`：第一次处理时已经关过了。

**执行**（`lib/payment-center/inbox-worker.ts`）：预付费的付款事件走的是另一条分支
（`payment.succeeded` + manual/blockchain/commission_balance），它**从来没有**
调用过 `cancelSupersededAutoRenew` —— 这正是「换成别的渠道后旧 Stripe 还在扣」的根因。
现在：

```ts
if (granted.planSwitched) {
  await cancelSupersededAutoRenew(intent.organizationId, null, send).catch(() => []);
}
```

Stripe 那条分支（`subscription.period_paid`）不变，它一直传 `provider_subscription_id`
并且本来就该无条件取消其他订阅。

**函数本身**（`lib/billing/subscription-controls.ts`）：`cancelSupersededAutoRenew` 第一行
原本是 `if (!keepProviderSubscriptionId) return [];` —— 换套餐到预付费渠道时旧订阅就是
在那行被跳过的。删掉它，并把「排除要保留的那条」写成条件式：

```ts
...(keepProviderSubscriptionId
  ? [ne(subscriptionGrants.providerSubscriptionId, keepProviderSubscriptionId)]
  : []),
```

**不能**直接写 `ne(col, null)`：SQL 里 `x <> NULL` 恒为 NULL，会把所有行都过滤掉 ——
正好是「一个都不保留」的反面。

### 五、连带修复：`getAuthorizedStripeSubscription` 不能依赖聚合表

**这是上面几处改动会连累到的地方，必须一起改，否则账单页的自动续费开关会凭空消失。**

`lib/billing/subscription-controls.ts` 原来 join 聚合表 `subscriptions`，并按
`subscriptions.paymentMethod = 'stripe'`、`subscriptions.providerSubscriptionId` 匹配。
而 `subscriptions` 只镜像**最新那条未过期 grant** 的字段（`service.ts` 的
`recomputeSubscription`），所以客户先 Stripe、后用 USDT 叠加之后：

- `subscriptions.paymentMethod` → `blockchain` ⇒ `eq(..., 'stripe')` 不成立
- `subscriptions.providerSubscriptionId` → `null` ⇒ 那个 `innerJoin` 直接断开

两条都让查询返回 `null`：账单页的「自动续费：开/关」开关消失，付款页的提醒也不显示 ——
明明 Stripe 还在扣款。

**改法**：不看聚合表，直接在 grants 上找那条还在跑的 Stripe 记录。两处细节：

- 去掉 `lte(periodStart, now)`，只看 `periodEnd > now`。叠加之后最新的 Stripe grant 可能
  排在将来（`periodStart > now`），按「正在生效」筛就把正在扣款的订阅筛没了。
  **未过期**才是「还在扣款」的正确判据。
- 加 `orderBy(desc(periodEnd))`：同时存在多条 Stripe grant 时，最新那条才是当前在跑的。

调用方 `app/api/payment-center/subscription/route.ts` 不用改：它本来就接受 `null`
并回 404 `subscription_unavailable`。

### 六、付款窗口的提醒（前端）

**新组件** `app/[locale]/(dashboard)/pricing/auto-renew-notice.tsx`：

- 挂载时 `GET /api/payment-center/subscription`
- 非 2xx（404 = 没有在跑的 Stripe 订阅）→ 什么都不显示
- `autoRenewEnabled === false` → 也不显示（客户已经关过了）
- 剩下的分两种，因为 D2 和 D3 的后果不一样：
  - **同一个套餐**：`autoRenewNotice` — 说明下次扣款日期、时间会叠加、Stripe 仍会扣款，
    后面跟一个去账单页的链接（`autoRenewBillingLink`）；
  - **不同的套餐**：`autoRenewPlanSwitch` — 说明付款成功后原自动续费会自动关闭。

日期用 `providerPeriodEnd`（中心给的 unix 秒，也就是下一次扣款日）格式化；为空时回退到
`periodEnd`。组件是 client component，时间在 `useEffect` 里落 state，不存在服务端/客户端
时区不一致的水合问题。

**挂载点** `app/[locale]/(dashboard)/pricing/pricing-plans.tsx`：`<AutoRenewNotice />` 放在
`<PaymentCenterCheckout ... />` **前面**，都在 `PaymentWindow` 内。

**不放进远程微件**（`payment-center.js`）：「这个工作区还有 Stripe 自动续费」是本站的业务
规则，不属于通用支付微件的职责，塞进去会让两个项目耦合。

**文案 key**（`messages/zh-CN.json` / `messages/en.json` 的 `Pricing` 段）：
`autoRenewNotice`（带 `{date}` 插值）、`autoRenewBillingLink`、`autoRenewPlanSwitch`。
同时把没人用、且已经说错的 `existingCheckout`（「你的账户已有付费账期……请先查看账单」）
改成和路由一致的口径。

## 不改什么（划清边界）

- `payment-center` 一行不动：`set_subscription_auto_renew`、`get_subscription` 已够用。
- Stripe 的扣款日**不推后**：不用 `trial_end`、不动 `billing_cycle_anchor`。
  按 D2，扣了就加时间。
- `SUBSCRIPTION_PROVIDER_SWITCH` 那个闸门不动：它管的是 `changeSubscription` 的
  `provider_switch` 动作（主动换渠道），跟定价页买时间不是同一条路径。
- 不做「成功后自动取消其他渠道」，见 D6。
- 布局里的支付微件（`payment-center-widget.tsx`）不动，提醒是本站自己的组件。

## 边界情况

| 情况 | 行为 |
|---|---|
| 客户已过期，没有未过期 grant | `running` 为空，时段从下单时刻起算，立即生效 |
| 付费期内买**同一套餐** | 新时段接在最新到期日之后；`planSwitched = false`，Stripe 不碰 |
| 付费期内买**另一个套餐** | 剩余时间折算 + 新套餐一整期；旧 grant 撤销；`planSwitched = true` |
| 折算算不出来（剩余不足 1 天 / 缺月付价） | 不折算，新套餐接在旧套餐到期日之后；`planSwitched` 仍为 `true`，旧 Stripe 照样关 |
| 客户有多条叠加的 grant | 取 `periodEnd` 最大的那条往后接 |
| 客户没有任何 Stripe 订阅 | 付款页不显示提醒；`GET .../subscription` 回 404 |
| 客户已关掉自动续费 | 不显示提醒（`autoRenewEnabled === false`） |
| Stripe 随后扣款成功 | 走现有 `continuationPeriod`，接在（可能已被预付费推后的）最新 `periodEnd` 之后 |
| 预付费那笔退款 | `reverseSubscriptionGrant` 按 `evidenceId` 只撤自己那一段，其他人的时段不受影响 |
| 两个人同时买 | `service.ts` 的 `SELECT ... FOR UPDATE` 行锁串行化，第二笔接在第一笔之后 |
| 同一笔预付费订单想申请第二段时间 | `Invoice evidence was already used differently`，仍然拒绝 |

## 测试

### 改掉的现有测试（规则本身变了，不是修 bug）

| 文件 | 现在断言 |
|---|---|
| `tests/provider-policy.test.ts` | 「第二渠道被拒」→「第二渠道可以下单并提交，且不立即产生 grant」 |
| `tests/provider-policy.test.ts` | 「付费期内预付费渠道被拒」那段删掉（Stripe 续费那半保留） |
| `tests/provider-policy.test.ts` | 「区分两类拒绝」→「指名占用了渠道的那笔未完成订单」，并补一条「换渠道不受影响」 |
| `tests/provider-policy.test.ts` | 删掉断言 `code: 'paid_period_exists'` 的那段 |
| `tests/subscription-grants.test.ts` | 「拒绝重叠的预付费时段」→「接在运行中的时段之后」（重叠拒绝的那条断言保留在同名的第二段） |
| `tests/subscription-grants.test.ts` | 「两个渠道抢一段，第二个失败」→「两个渠道各自拿到一段，首尾相接」 |
| `tests/subscription-grants.test.ts` | 换套餐折算的断言改成「中心的一期 + 折算天数」（`nowSeconds + 40 * DAY`） |

### 新增的测试

1. `prices the exchange when a prepaid channel takes over the plan` —— 预付费换套餐时
   下单会算出折算值（Pro 28 天 ÷ 3 ≈ 84 天 Starter）。
2. `still finds the live Stripe subscription behind a newer prepaid purchase` ——
   聚合表已经翻成 `manual` 且 `provider_subscription_id` 为 null，
   `getAuthorizedStripeSubscription` 仍能返回那条还在跑的 Stripe 订阅。
3. `converts a prepaid plan switch and reports it as one` —— 跨渠道换套餐：折算值 +
   中心一期相加、旧 grant 变 `reversed`、`planSwitched = true`。
4. `stitches a prepaid purchase made inside a running period onto its end` 里补了
   `planSwitched = false` 的断言（同套餐叠加不该触发取消）。

## 验收方式

- `npx vitest run` 全绿（除 `.env` 里 `FEATURE_COMMISSION_BALANCE=true` 造成的两条已知红）。
- `npx tsc --noEmit`、`npx eslint .` 无新增问题。
- 真实浏览器（`localhost:3000`，Chrome DevTools）：
  1. 有 Stripe 自动续费的账号打开定价页 → 提醒出现，写明下次扣款日；
  2. 选**同一个套餐** → 文案是「会叠加、Stripe 仍会扣」，带账单页链接；
  3. 选**另一个套餐** → 文案变成「付款成功后自动关闭」；
  4. 去账单页关掉自动续费，回到定价页 → 提醒消失。
- 数据库侧：买一次同套餐，确认新 grant 的 `period_start` 正好等于旧 grant 的 `period_end`。
