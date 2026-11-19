# 返佣等级阶梯与规则说明

## 目标

SaaS Framework 的返佣页面目前只显示「当前渠道比例」和一行「再有 N 笔可达到 X」。本次让它同时显示：

1. 当前用户在各支付渠道生效的返佣比例（已有，保留）；
2. 完整的等级阶梯与升级条件（门槛、比例、Cookie、返佣期限）；
3. 返佣体系说明：Cookie 的确切含义、返佣的有效期。

数据全部由 Payment Center 实时提供，页面不缓存、不写死任何数字。

## 范围

**只修改 `saas-framework`。`payment-center` 零改动。**

所需数据 Payment Center 均已通过现有只读接口输出：

| 需要显示的内容 | 现成出处 |
|---|---|
| 各渠道生效比例 | `GET /api/referral-center/users/{id}/summary` 的 `effective_rates[]` |
| 当前等级、有效订单数 | 同上：`tier.code`、`order_count` |
| 返佣期限（当前等级） | 同上：`commission_term_months` |
| 全部等级（升级条件） | `GET /api/referral-center/tiers` |

两个接口都要求 `referral_read` 权限，现有 `PAYMENT_CENTER_REFERRAL_API_KEY` 已具备（summary/ledger 用的是同一权限）。

不在本次范围内：AutoTrading 的同类页面、提现流程、Payment Center 后台规则页。

## 数据契约

`GET /api/referral-center/tiers` 返回 `{status, data: {tiers: [...]}}`，每个等级来自 `ReferralTier.to_dict()`：

| 字段 | 类型 | 用途 |
|---|---|---|
| `website_id` | string | **绑定校验**：必须等于 `PAYMENT_CENTER_WEBSITE_ID`，否则整段阶梯作废 |
| `code` | string | 与 `summary.tier.code` 比对，定位「你在这里」 |
| `name` | string | 等级名 |
| `min_order_count` | integer ≥ 0 | 升级门槛 |
| `commission_rate` | number 0~1 | 等级默认比例 |
| `cookie_days` | integer 1~3650 | Cookie 天数 |
| `commission_term_months` | integer 0~120 | 返佣期限，`0` 表示不限 |
| `priority` | integer | 门槛相同时的排序，用于镜像服务端的等级判定 |
| `is_active` | boolean | 接口已只返回启用中的等级 |

`summary` 侧新增读取的字段：`commission_term_months`（0~120 的整数，非法值按 `null` 处理并隐藏期限文案，不让整页失败）。

字段校验一律遵循 `lib/referrals/overview.ts` 现有习惯：类型不对就抛错，界面文案类的字段（如 `rule_name`）宽容处理。唯一例外是 `/tiers` 整体失败时的降级，见下。

## 取数层（`lib/referrals/overview.ts`）

1. 在 `getReferralOverview` 已有的 `Promise.all` 中**并行**增加一次 `/tiers` 请求，不增加用户等待时间。
2. 新增内部函数 `getReferralTiers(send)` 负责请求与逐行校验，返回 `{ code, name, minOrderCount, commissionRate, cookieDays, commissionTermMonths, priority }[]`，按 `min_order_count` 升序（服务端已排序，前端不重排）。
3. `getReferralOverview` 的返回值增加：
   - `tiers`：上面的数组；
   - `commissionTermMonths`：当前等级的返佣期限（`number | null`）。
4. **降级**：`/tiers` 请求失败、响应格式非法或 `website_id` 不匹配时，`tiers` 返回空数组，其余数据照常返回。页面在阶梯为空时退回现有的一行 `next_tier` 提示。理由：一张辅助列表不该让余额、提现、流水一起不可用。绑定不匹配在阶梯层按「不可用」处理，而不是让整页抛错。
5. `rates[]` 继续解析 `cookie_days`（不因界面不再显示而删除），因为它才是 Payment Center 实际生效的每渠道 Cookie 值，保留校验可以及早发现响应变形。

## 展示层（`app/[locale]/(dashboard)/dashboard/referrals/page.tsx`）

新的卡片顺序：

```
余额卡片（等级、有效订单数）
提现表单
等级与升级条件          ← 新增
当前渠道返佣比例        ← 去掉每行重复的 Cookie
邀请 / 佣金流水 / 提现   ← 不动
```

### 等级阶梯卡片

- 逐级列出全部等级，每级显示：等级名、门槛（`{count} 单起`）、比例、`Cookie {days} 天`、`返佣 {months} 个月`（`0` 时显示「返佣不限期限」）。
- 当前等级高亮并标注「你在这里」；门槛更低的等级淡化并标注「已达成」。
- 当前等级判定：优先用 `summary.tier.code` 在阶梯里按 `code` 匹配；匹配不到时，退化为镜像服务端 `get_current_tier` 的规则——取 `min_order_count ≤ order_count` 中 `min_order_count` 最大、`priority` 最小的一级。
- 阶梯下方一行进度：取阶梯中第一个 `minOrderCount > orderCount` 的等级，显示「已 {count} 笔有效订单，距 {tier} 还差 {remaining} 笔」；没有更高的等级时显示「已是最高等级」。
- 阶梯为空（降级路径）时，这一块只渲染现有的一行 `next_tier` 提示；若阶梯为空且 `nextTier` 也为 `null`，整张卡片不渲染。

### 规则说明（折叠）

- 用原生 `<details>` / `<summary>`，默认收起，放在等级阶梯卡片底部，用上边框与阶梯分隔。不需要 JavaScript，不使用 `animate-*`。
- `<summary>` 是交互元素，必须带 `min-h-11` 和 `focus-visible:outline-*`，与页面现有 `pagerClass` 一致；测试里的 `interactiveTags` 扫描范围要加上 `summary`，让这条规矩被固化下来。
- 展开后两段：

> **Cookie 是什么？**
> 它只管「点邀请链接 → 注册」这一段：Cookie 有效期内点过你链接的人，注册后就算你邀请的。绑定一旦记进数据库就是永久的——Cookie 过期只影响还没注册的新访客，已经绑定的人不受影响。
>
> **返佣能拿多久？**
> 从每位客户的「首笔已确认付款」那天起算，按自然月计算，你当前等级是 {months} 个月。到期后这位客户再下单不再产生佣金，但已经发给你的佣金不会被收回。

`commissionTermMonths` 为 `0` 时，第二段换成「你当前的等级不限返佣期限，绑定客户产生的每笔订单都会计佣。」；为 `null` 时整段隐藏，只留 Cookie 一段。

### 渠道比例卡片

去掉每行重复的 `Cookie {days} 天`（Cookie 是等级属性，四个渠道永远同值，阶梯上已显示一次）。每行保留：渠道名、规则名、比例、「已关闭」标记、来源说明。

## 文案（`messages/en.json` 与 `messages/zh-CN.json`）

新增 `Referrals` 词条，两份必须一一对应（现有测试要求两侧键集合完全相同、英文词条不得含中日韩字符）：

| key | zh-CN | en |
|---|---|---|
| `tiersTitle` | 等级与升级条件 | Tiers and upgrade conditions |
| `tiersDescription` | 等级由有效订单数自动决定；升级后所有渠道的比例、Cookie 和返佣期限一起生效。 | Your tier follows your qualified order count. Moving up moves every channel's rate, cookie window and commission window with it. |
| `tierHere` | 你在这里 | You are here |
| `tierReached` | 已达成 | Reached |
| `tierThreshold` | `{count} 单起` | `{count}+ orders` |
| `tierTerm` | `返佣 {months} 个月` | `{months}-month commission window` |
| `tierTermUnlimited` | 返佣不限期限 | No commission time limit |
| `tierProgress` | `已 {count} 笔有效订单，距 {tier} 还差 {remaining} 笔` | `{count} qualified orders — {remaining} more to reach {tier}` |
| `tierProgressTop` | `已 {count} 笔有效订单，已是最高等级` | `{count} qualified orders — you are on the highest tier` |
| `rulesTitle` | 返佣规则说明 | How commissions work |
| `rulesCookieTitle` | Cookie 是什么？ | What is the cookie for? |
| `rulesCookieBody` | 见上 | The cookie only covers the step from clicking your invite link to signing up. Someone who opens your link while it is valid is bound to you when they register. A binding is permanent once recorded: an expired cookie only stops new visitors from being credited to you, and never releases people already bound. |
| `rulesTermTitle` | 返佣能拿多久？ | How long do I keep earning? |
| `rulesTermBody` | 见上 | Counted in calendar months from each customer's first confirmed payment. Your current tier earns for {months} months. After that, new orders from that customer stop earning commission — but commission already paid to you is never taken back. |
| `rulesTermBodyUnlimited` | 见上 | Your current tier has no commission time limit, so every order from a customer bound to you earns commission. |

现有的 `cookieDays` 词条继续复用（阶梯显示 Cookie 用）。文案里除插值外不出现具体数字，管理员改了等级名或天数，页面不会说错话。

## 失败与限制

- `/tiers` 取不到：阶梯不显示，退回一行 `next_tier` 提示；余额、提现、邀请、流水完全不受影响。
- `/tiers` 返回的 `website_id` 与本网站不符：同上按不可用处理，不渲染其它网站的等级。
- 单个等级字段非法（比例越界、门槛为负、期限超 120 个月）：整段阶梯作废并降级，不猜测、不修正。
- `commission_term_months` 缺失或非法：期限文案隐藏，Cookie 说明照常显示。
- 等级名和天数全部来自接口，改 Payment Center 的规则后台会随页面刷新即时生效；页面没有本地副本，不引入缓存。

## 验证

1. `tests/referral-ui.test.ts`
   - `stubCenter` 增加 `/tiers` 分支与 `tiers` 选项；
   - 断言阶梯解析正确（门槛、比例、Cookie、期限、排序）；
   - 断言 `/tiers` 失败时 `tiers` 为空数组且 `overview` 仍为 `ready`；
   - 断言 `website_id` 不匹配的等级被剔除；
   - 新词条在中英两侧都存在，英文不含 CJK；
   - 页面源码包含阶梯渲染、`<details>`、「你在这里」与两段说明的引用；
   - `interactiveTags` 扫描范围加入 `summary`，确保 44px 规矩覆盖折叠控件；
   - 现有断言 `expect(page).toContain("t('cookieDays', { days: entry.cookieDays })")` 描述的是渠道行上的 Cookie，本次不再成立，改为断言阶梯渲染 Cookie 天数。
2. `npm run typecheck`、`npm run lint`、`npm test`。
3. 真实浏览器验证：本地启动 saas-framework 与 payment-center，用 Chrome 打开返佣页，实际点击折叠面板、核对阶梯数字与 Payment Center 后台一致、确认渠道卡片不再重复显示 Cookie。
