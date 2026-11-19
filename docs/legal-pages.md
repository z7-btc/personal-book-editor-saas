# 多语言法律页模板

## 当前交付与发布边界

每个站点语言（`en`、`zh-CN`、`ja`、`de`、`es`、`fr`，见 `i18n/routing.ts`）都提供 `/privacy` 和 `/terms`，共 12 个页面，沿用现有灰白/深色页面样式、语言和主题组件。法律页自带 `components/legal/public-shell.tsx`，不依赖 `(dashboard)` 路由组的公共导航。

默认是**未完成草稿**，页面显示缺失项，metadata 为 `noindex, nofollow`。没有虚构公司、邮箱、地址、生效日期、退款保证、适用法律、监管合规或生产验收。模板说明当前代码的数据流，不构成已发布的运营政策；也没有实现条款接受记录、账户删除流程或新的管理功能。

## 配置扩展点

`lib/legal/config.ts` 只保存可公开的部署事实，不读取新增环境变量，不增加数据库字段或保存秘密。

| 配置 | 默认 | 需要运营者提供的内容 |
|---|---|---|
| `operatorName` | `null` | 真实运营者名称 |
| `supportContact` | `null` | 每一种站点语言的显示文字及真实 `mailto:` 或 HTTPS 联系链接；不允许脚本 URL 或嵌入账号密码 |
| `effectiveDate` | `null` | 审核确定的实际生效日期，格式 `YYYY-MM-DD`；日期不能自动推定 |
| `privacyDetails` | `null` | 每一种站点语言的实际接收方/处理者身份、部署与存储地区、保留及删除规则、请求流程，以及实际需要的其他告知 |
| `termsDetails` | `null` | 每一种站点语言的实际退款/取消、使用资格、支持和商业政策；法律适用或争议条款由运营者自行审核决定 |
| `approvedForPublication` | `false` | 在真实部署事实、全部语言文案和适用要求审核完成后显式批准 |

`getLegalPublicationStatus(config?)` 返回 `{ isDraft, missingFields }`。缺少任一配置、缺少任一站点语言的文本（部分翻译会渲染出一个空白页面，所以按未完成处理而不是回退英文）、无效日期/联系链接或尚未显式批准，都保持草稿。`getLegalSupportContact(config?)` 只返回有效的公共联系链接。发布开关是工程保护，不能证明法律合规或生产就绪。

运营者完成配置前，还应将法律页文案（中文、英文在 `messages/legal.zh-CN.json` / `messages/legal.en.json`，另四种语言直接在各自主 bundle 的 `Legal` 命名空间里）中的技术事实与实际功能、服务商、生产验收、保留/删除实现逐项核对。仅添加补充段落或打开开关不能使过时的正文变成真实政策。保留当前版本以便审核；本任务没有发布或部署任何内容。

## 当前事实依据

以下按 2026-10-04 的 SaaS 代码核对。独立中心的服务商身份和真实部署地区仍需运营者补齐。

| 页面事实 | 当前证据路径与限制 |
|---|---|
| 邮箱密码账户、会话、IP/浏览器字段、语言及营销选择 | `auth.config.ts`、`lib/auth.ts`、`lib/db/auth-schema.ts`；基础注册不先验证邮箱，注册/登录不发邮件验证码 |
| 事务邮件是独立适配器 | `lib/transactional-email/resend.ts`；找回密码、邮箱确认/变更使用限时链接，当前不经 Email Center 活动邮件通道 |
| 两中心职责分开 | `lib/payment-center/*`、`lib/email-center/contact.ts`、`lib/email-center/worker.ts`；Payment Center 为支付/返佣权威，Email Center 为联系人、授权与投递抑制权威 |
| 未确认邮箱不向中心发送 true 营销授权 | `lib/email-center/contact.ts::contactSnapshot`；对账尊重外部退订、退信、投诉、抑制及更新的偏好 |
| 本地付款与权益为已验证事实镜像 | `lib/billing/intents.ts`、`lib/subscription/service.ts`、`lib/db/integration-schema.ts`；跳转或中间态不是权益开通证据 |
| 自动续费只针对已授权个人 Stripe 订阅 | `lib/billing/subscription-controls.ts`；完整即时换套餐、提前叠加预付尚未提供 |
| 当前仅 USDT 提现、近期认证与已确认邮箱 | `lib/referrals/withdrawal-intent.ts`；收款账户加密存储与普通 DTO 脱敏见 `withdrawal-crypto.ts` / `withdrawal-worker.ts` |
| 浏览器使用请求编号和邀请归因 | `app/[locale]/(dashboard)/pricing/payment-center-widget.tsx`（付款界面由本站自建 Payment Center 的远程脚本 `payment-center.js` 渲染，仅在定价页加载，不是第三方统计或广告脚本）、`components/referrals/withdrawal-form.tsx`、`app/[locale]/invite/[code]/route.ts`；语言由 next-intl 处理，主题选择保存在本站 `theme` cookie 并由服务端渲染到 `<html>`（`lib/theme.ts`、`components/theme-switcher.tsx`），不加载任何第三方统计 SDK、像素或广告脚本 |
| 保留、删除仍有缺口 | `.env.example` 的 retention 变量已接入 `lib/jobs/retention.ts` / `lib/jobs/maintenance.ts`（默认完成 30 天、失败 90 天、审计 365 天，`npm run maintenance` 执行，`--dry-run` 只统计）；当前仍没有自助删除/全量导出入口。页面不把计划中的天数写成已生效期限，也不承诺删除外部中心记录 |

本地付款或邮件合同测试不能替代真实支付渠道、生产投递、提现结算、备份与部署安全的验收。

## 官方起草参考

以下仅用于识别需要补齐的告知与核对安全组件，不代表判断某个司法辖区适用或完成监管合规。查阅日期：2026-10-04。

- [《中华人民共和国个人信息保护法》，中央网信办发布的法律正文](https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm)：第 17 条涉及处理者身份/联系方式、处理目的方式、信息类别、保存期限和权利行使方式的告知；第 19 条涉及保存期限；第 21/23 条涉及委托处理或其他接收方。模板因此明确留下真实运营者、接收方和保留/请求政策的配置缺口，不据此宣称本网站合规。
- [Cloudflare Turnstile Privacy Addendum](https://www.cloudflare.com/turnstile-privacy-policy/)：官方列出的挑战信号包括 IP、浏览器及连接相关信号，用于区分真人与机器请求。页面提供该官方链接，不把 Cloudflare 联系方式当本站支持渠道。
- [Cloudflare Turnstile Get started](https://developers.cloudflare.com/turnstile/get-started/)：浏览器挑战 token 需服务端验证。结合当前认证代码，Turnstile 安全验证与邮箱归属确认是不同流程。

## 根代理需要接入的接口

1. `i18n/request.ts` 按 locale 加载对应的主 messages 文件；中文和英文的 `Legal` 命名空间以 `messages/legal.zh-CN.json` / `messages/legal.en.json` 为源、手工同步进主文件（`tests/i18n.test.ts` 校验两份副本不漂移），其余四种语言直接写在主文件里。新增语言时同样要补齐 `Legal` 命名空间的全部小节（`tests/legal.test.ts` 会逐个语言检查）。
2. `lib/seo.ts::publicPageMetadata` 的 path union 增加 `/privacy` 和 `/terms`。法律 metadata 复用 canonical/hreflang/OG，并以发布状态覆盖 robots。
3. 公共导航/页脚可链接法律页。注意 `app/sitemap.ts` 目前**无条件**收录 `/privacy` 和 `/terms`，而草稿状态下这两页是 `noindex`——两者互相矛盾，属基线既有行为，尚未修。草稿允许直接访问以便审核，不提前索引。
4. 根代理统一管理 Web 3000 与整体 `npm run typecheck` / `npm run build`。

## 本地 HTTP 验证

完成上述 messages/SEO 接入，并由根代理启动本地服务后，在 SaaS 仓库执行：

```powershell
node --import tsx scripts/smoke-legal-pages.mts
```

也可传入本地 HTTP 地址：

```powershell
node --import tsx scripts/smoke-legal-pages.mts http://127.0.0.1:3000
```

脚本拒绝非 loopback 或非 HTTP 地址，不创建账户、付款或邮件。它读取四个真实 HTTP 页面，验证状态码、语言、独立 title/description、canonical/hreflang/OG、草稿 robots 和可见草稿说明，以及实际配置缺口/联系链接/日期真实性和公共导航。Crawler User-Agent 使 Next.js 在 head 返回 metadata。它不按整段文案做镜像断言，也不代表浏览器视觉、生产验收或法律审核已经完成。
