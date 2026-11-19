# 待外部条件：本地无法闭环的部分

本文记录 saas-framework 中**依赖外部系统、无法在本机闭环**的事项。每一条都写清楚四件事：缺什么、为什么本地证明不了、本地已经证明到哪一步、补上之后要跑什么验收。

本仓库的策略是：**缺少第三方凭据时报告为 blocked，绝不伪造通过**。`npm run smoke` 的 11 个 live 套件默认不启动，只有显式 `--live=NAME` 才会跑，就是为了让"没验证"保持可见。离线套件缺本机前置条件时同样报告 blocked：`referral-sync` 要求 referral 队列为空、`email-sync` 要求本地库没有 user 行、`billing-controls` 要求本机没有第二个 `next dev` 占用该项目；这类套件打印 `[smoke:<name>] blocked: <原因>` 并以退出码 2 结束，runner 在 `Blocked smoke suite(s)` 里单独列出，**不计为通过**。

配套阅读：`README.md` 的 "Current development state" 与 "## Verification"、`docs/integration-contracts.md`（Payment Center / Email Center 接口契约）、`docs/recovery-runners.md`（常驻与定时任务）。

---

## 一、资金与支付（需要真实的 Payment Center 与真实渠道）

> **本机已闭环的局部（2026-10-04 复核）**：同级项目 `E:\Project\全栈项目\payment-center`（Flask + PostgreSQL，非 mock）已与本应用跑通完整链路并留下数据库证据：注册 → `/pricing` 读到真实目录（`starter` / `pro`，月价与年价）→ 下单（`manual`，订单 `7251e604-5b2f-4ee7-ada7-704a825da30c`）→ 人工审批（走的是后台「通过」按钮同一条服务代码 `GatewayPaymentService.review_manual`）→ 签名回调投递（HTTP 202）→ `npm run reconcile` 处理 Inbox → 生成 `payment_evidence` 与生效中的 `subscription_grants` → 握手三个模块（`payment_pricing` / `referral` / `payment_callback`）全部 `ready`。本机 `.env` 因此打开 `FEATURE_PAYMENT_CENTER` 与 `FEATURE_REFERRALS`。
>
> **同日后续改动**：回调路由已改为**收到即处理**——`POST /api/payment-center/webhook` 验签、落库后立刻只领取这一条 `event_id` 并完成授权，因此上表那次 `npm run reconcile` 是当时的步骤，现在只是重试兜底；本机 `RECOVERY_RUNNER_MODE` 仍按计划保持 `manual`。
>
> **同日集成方式重构**：定价页不再自己渲染「币种 × 周期」的价格行，而是按同级 `E:\Project\全栈项目\autotrading` 的做法挂载 Payment Center 的远程脚本 `payment-center.js`（`window.PaymentCenter.mount`）：每个套餐一张卡片、一个挂载点，`productCode` 锁死，付款方式/周期/链上网络由中心组件自己选，`createOrder` 回调本站 `/api/payment-center/checkout` 创建服务端 intent 与中心订单。四个 USDT 目录价已下架（下架前要求同套餐同周期仍有生效的 USD 价），因此组件里只剩 USD 周期、银行卡付款不会再被要求选币种；链上支付仍按 1:1 用 USDT/USDC 结算 USD 定价的套餐。当天用**全新账号 + Stripe 测试卡 `4242 4242 4242 4242`** 在真实托管收银台完成付款：intent `settled`、`payment.succeeded` 与 `subscription.period_paid` 都在回调内处理完、浏览器返回 `/dashboard` 前授权已生效，**没有运行任何 reconcile 命令**。仍属本地证据：真实 Stripe 密钥、链上真实结算、真人后台审批、真实打款与生产站点绑定都还没验收；另外中心组件文案只有中文（其社区组件有语言切换，收银组件没有），英文定价页上会显示中文付款文案。
>
> **这不等于生产可用**：下面第 1–5 条的真实渠道、真实运营审批、真实打款与生产站点绑定仍未验证；本机用的是本地手动收款方法与本地测试密钥。

### 1. 真实 Stripe 收款与订阅控制

- **状态**：本地已用 mock Payment Center + 签名回调 + reconcile worker 证明周期授权、冲正、重放幂等。**真实 Stripe 控制未验证**。
- **为什么本地闭环不了**：本仓库按计划**不直接集成 Stripe**（禁止 Stripe 收款 SDK），一切 Stripe 交互都在 `E:\Project\全栈项目\payment-center` 侧。本地没有真实 Stripe 账户、真实 invoice、真实 dispute。
- **补上之后要验收**：
  1. 账单页对**已验证的真实 Stripe 授权**查询并在允许范围内修改自动续费（`app/api/payment-center/subscription/route.ts`）。
  2. 一张真实 invoice 付清 → 回调 → 本地 reconcile 生成**恰好一条**期间授权；同一 invoice 重放不新增授权。
  3. 真实全额退款、真实 lost dispute → 只冲正**被退的那一期**，后续续费期不受影响。
  4. 真实 partial refund / 未决 dispute → 停在人工复核，不自动改权限。

### 2. 区块链（USDT/USDC on BSC/Arbitrum）确认

- **状态**：本地只证明了"确认后的回调驱动授权"这条路径（`scripts/smoke-prepaid-grants.mts`）。**真实链上确认未验证**。
- **为什么本地闭环不了**：计划**禁止链上监听 SDK**（viem/ethers/web3/TronGrid/Alchemy 一律不许），链上事实只能由 Payment Center 给出。本地没有真实链、真实交易、真实确认数。
- **补上之后要验收**：真实转账 → Payment Center 报告确认 → 回调 → 预付费期间授权；确认数不足时不得授权；同一 txid 重放幂等；金额/币种/网络不匹配时进入人工复核而不是授权。

### 3. 人工（manual）与银行转账审批

- **状态**：本地已证明"人工审批通过 / 已确认的链上付款"走预付费期间授权路径；2026-10-04 起还额外跑通了**真实 Flask Payment Center 的人工审批**（同一服务代码 `GatewayPaymentService.review_manual`，即后台「通过」按钮调用的那一条），签名回调 → Inbox → 授权全部留证。**真实运营在真实队列里点击、以及驳回/撤销分支仍未验证**。
- **为什么本地闭环不了**：按计划本仓库**不做运营后台**——没有管理页面、管理 API、管理员角色、任务重排 UI。审批发生在 Payment Center 侧；本机复核是以同一服务代码直接调用，等价于后台点击，但不是真人在页面上操作。
- **补上之后要验收**：真实运营在真实队列里批准一笔人工付款 → 回调 → 授权；驳回 → 不授权；批准后撤销 → 冲正对应期间。

### 4. commission_balance（余额抵扣）

- **状态**：本地两阶段路径（reserve → prepare → confirm，`lib/billing/commission-preparation.ts`）已实现并通过单测；**完整崩溃/并发矩阵与真实用户结账验收未完成**，`FEATURE_COMMISSION_BALANCE` 保持关闭。
- **为什么本地闭环不了**：需要真实佣金余额、真实扣减规则与真实订单；零金额 invoice 策略也还没定。
- **补上之后要验收**：计划明确要求"合同 + 失败测试通过后才可开启"。至少要补：崩溃于 reserve 与 confirm 之间可恢复、同/跨 intent 并发 prepare 恰好一次、扣减后余额不出现负数、退款按规则回补、零金额订单策略确定。**在此之前该功能保持 disabled。**

### 5. 真实打款 / 提现

- **状态**：本地已证明加密落库、签名幂等请求、租约重试同外部 ID、部分失败分类（`scripts/smoke-withdrawal-intent.mts`、`withdrawal-dispatch`）。**真实余额与真实打款未验证**。
- **为什么本地闭环不了**：本地 mock/浏览器检查证明不了真实余额、真实收款账户有效性和真实出款。
- **补上之后要验收**：真实账户提现成功并留下 `submitted` 事实；被拒为 `rejected`；网络中断进入 `uncertain` 并用**同一个外部 ID** 重试；重试不会造成第二笔出款。`FEATURE_REFERRAL_WITHDRAWALS` 在此之前保持关闭；`FEATURE_REFERRALS` 本机已开启，仅用于本地联调，生产要等真实提现验收完成后再开。

---

## 二、Email Center 与邮件

### 6. 生产 Email Center 绑定

- **状态**：本地专用 Email Center 应用可接受真实注册/语言/同意变更，公开页可选 Widget 已加载并检查（zh/en/移动端）。**生产 Email Center 绑定未完成**。
- **为什么本地闭环不了**：需要生产站点的站点级 API Key、生产 Widget Key、生产域名与证书。
- **补上之后要验收**：真实站点注册 ≤30 秒内到达 Email Center（轮询 ≤10s 或常驻 worker）；语言与营销同意双向一致；退订不被后续同步覆盖；Widget 在生产域名加载且不进入任何私有页面。

### 7. 事务邮件真实发件人

- **状态**：`lib/transactional-email/resend.ts` 已实现验证邮件、邮箱变更（双信箱确认）、密码重置（1 小时、单次使用、成功后吊销会话），但**只对本地 mock 跑过**。
- **为什么本地闭环不了**：需要真实发件域名与真实收件箱；计划禁止在本仓库伪造投递成功。
- **补上之后要验收**：真实域名完成 SPF/DKIM/DMARC；`RESEND_API_KEY` 与 `FEATURE_TRANSACTIONAL_EMAIL=true`；真实收件箱收到验证/变更/重置邮件；链接过期、重复使用、会话吊销全部按预期拒绝。对应 live 套件：`email-verification-live`、`password-reset-live`、`account-settings-live`。

---

## 三、机器人与风控

### 8. Cloudflare Turnstile 生产校验

- **状态**：代码在 `NODE_ENV=production` 下**拒绝** Cloudflare 官方测试密钥（fail-closed，见 `lib/config.ts` 与 `tests/security.test.ts`），本地开发链路已通过。
- **为什么本地闭环不了**：需要真实站点密钥与真实 `siteverify` 往返。
- **补上之后要验收**：生产环境用真实密钥；伪造 token 被拒；`siteverify` 不可用时**失败关闭**（不放行）而不是放行。

---

## 四、部署与运维平台

### 9. 生产部署与生产冒烟

- **状态**：本地 dev/build/E2E 全绿；**部署与生产冒烟未做**。
- **为什么本地闭环不了**：需要一台真实主机、真实域名、HTTPS、真实数据库。
- **补上之后要验收**：
  - `/api/health` 与 `/api/ready` 在生产可用；`/api/ready` 只暴露 `status`/`database`/`modules`，不泄露持有哪些第三方密钥。
  - 根路径 307 跳转在**真实 CDN/边缘缓存**下的行为与 `Vary`（本地只验证到响应头层面；`proxy.ts` 与边缘运行时行为本地不可验证）。
  - `BETTER_AUTH_SECRET`、`CRON_SECRET`、`INTEGRATION_ENCRYPTION_KEY_V1` 由密钥管理注入，不是本地生成的默认值；`npm run setup`（无 `--rotate`）不会覆盖已存在的 `.env`。

### 10. 常驻 worker / 定时任务

- **状态**：`scripts/worker.mjs` 是 HTTP 调度器（`--once` / `--watch`），`npm run reconcile` 与 `/api/internal/*`（`CRON_SECRET` 保护）是同一套入口；`npm run dev` **不会**自动启动它们。
- **为什么本地闭环不了**：生产需要真实的进程管理器 / 定时器（cron、systemd、容器编排或平台定时任务）。
- **补上之后要验收**：生产确实在跑 `worker`/`reconcile`；`CRON_SECRET` 缺失或错误时接口返回 503/401 而不是执行；一次失败不会并发持两个同队列租约。

### 11. 生产数据库、备份与迁移

- **状态**：本地已有可复现的 22 个迁移（`db:generate` + `db:migrate`），测试套件为每个测试文件克隆独立数据库。
- **为什么本地闭环不了**：需要真实托管 PostgreSQL：连接池、备份、PITR、迁移回滚演练。
- **补上之后要验收**：迁移在生产可重复执行且幂等；备份可恢复；恢复演练通过。

### 12. 密钥轮换演练

- **状态**：`npm run generate-secret` 生成正确形状；`npm run setup -- --rotate` 会警告 `BETTER_AUTH_SECRET` 轮换会登出所有会话、`INTEGRATION_ENCRYPTION_KEY_V1` 轮换会让已存提现账户不可读。
- **为什么本地闭环不了**：需要真实密钥托管与真实存量数据。
- **补上之后要验收**：轮换 `BETTER_AUTH_SECRET` 后旧游标/邀请票据失效但不影响数据（已有单测覆盖语义）；轮换加密密钥时**保留旧版本密钥**，历史提现记录仍可用其记录在行的 `keyVersion` 解密（V1/V2 轮换已有单测覆盖）。

### 13. 三个项目联合的本地/预发 E2E

- **状态**：**SaaS + Payment Center 已在本机以真实进程联合跑通一条完整链路**（注册 → 定价目录 → 手动收款下单 → 人工审批 → 签名回调 → Inbox → 期间授权，证据见第一节开头的复核记录）；Email Center 仍由各自的 live 套件单独验证。**三个项目同一条用户旅程与预发环境仍未完成**。
- **为什么本地闭环不了**：需要同时启动三个项目、真实绑定站点级密钥，并在预发环境跑一遍完整用户旅程；本机已跑通的那条链路只覆盖了定价到授权这一段，且用的是本地手动收款方法。
- **补上之后要验收**：注册 → 邀请归因 → 定价 → 结账 → 回调 → 授权 → 账单页 → 推荐页 → 提现，全部在真实三项目上跑通。

---

## 五、本地已经证明到哪一步

下面这些命令在**本机**即可运行，且是"未验证"与"已验证"的分界线。任何新增的第三方依赖都必须先落在这里。

```powershell
npm run lint
npm run typecheck
npm test                 # 每个测试文件克隆独立数据库
npm run build
npm run seed             # 只校验，不写入
npm run maintenance -- --dry-run
npm run smoke            # 16 个离线套件；11 个 live 套件默认跳过并说明原因
                         # 离线套件缺前置条件时打印 [smoke:<name>] blocked: <原因> 并退出码 2，
                         # 汇总行是 Blocked smoke suite(s)，不计为通过
npm run test:e2e         # 驱动真实 dev server 与开发数据库
npm run reconcile        # 重试兜底：领取并处理 Payment Center 签名 Inbox 事件（幂等、带租约）
                         # 正常路径已由回调自身完成：`POST /api/payment-center/webhook`
                         # 验签后就地处理这一条投递（只领取它自己的 event_id），
                         # 收到款即生效，不再依赖 reconcile/worker
```

需要真实第三方时，必须显式点名：

```powershell
npm run smoke -- --live=payment-center-live
npm run smoke:payment-handshake      # 未注册进 smoke.mjs，直接跑这个脚本
npm run smoke -- --live=payment-binding-live
npm run smoke -- --live=referral-binding-live
npm run smoke -- --live=email-center-live
```

**报告规则**：任何一个 live 套件没跑，就在验收记录里写成"待外部条件"，并写明缺什么。不得用 mock 结果代替真实渠道结论，也不得把 mock 通过描述成生产可用。

---

## 六、功能开关：本机现状与生产默认

下表最后一列是**生产开启前还缺什么**；中间一列是本机 `.env` 的现状（本机只打开本地可验证的部分）。

| 开关 | 本机 `.env` | 生产开启前还需要什么 |
| --- | --- | --- |
| `FEATURE_PAYMENT_CENTER` | `true`（绑定同级 Payment Center，已跑通目录 / 下单 / 回调） | 绑定真实站点并在生产验证目录、下单与回调（见第一节） |
| `FEATURE_REFERRALS` | `true`（返佣专用 Key 已能证明站点绑定） | 真实佣金规则与真实打款验收（见第 5 条） |
| `FEATURE_REFERRAL_WITHDRAWALS` | 未设置（关闭） | 真实打款验收 + 专用提现 Key 与签名密钥（见第 5 条） |
| `FEATURE_COMMISSION_BALANCE` | 未设置（关闭） | 合同 + 完整崩溃/并发失败矩阵（见第 4 条） |
| `FEATURE_EMAIL_CENTER` / `FEATURE_EMAIL_CENTER_WIDGET` | `true` / `true`（绑定同级 Email Center） | 生产 Email Center 绑定与生产 Widget Key（见第 6 条） |
| `FEATURE_TURNSTILE` | `true`（Cloudflare 官方测试密钥，仅本地） | 真实站点密钥；生产环境拒绝测试密钥（见第 8 条） |
| `FEATURE_TRANSACTIONAL_EMAIL` | `false` | 真实发件域名与收件箱验证（见第 7 条） |

生产默认仍是全部关闭：`lib/config.ts` 只有读到字面量 `'true'` 才视为开启，缺失密钥一律 fail-closed。
