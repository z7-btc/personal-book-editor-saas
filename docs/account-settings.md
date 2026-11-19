# 账户设置与邮箱变更

## 当前范围

- 账户页支持保存显示名称、邮件语言和营销订阅意愿，站点支持的每种语言均可使用。
- 使用既有 Better Auth `updateUser` 与 PostgreSQL 联系人 Outbox，用户资料和同步事件一起提交。界面语言切换不自动修改邮件语言。
- 原始营销意愿与实际订阅状态分开：未确认邮箱时只同步 `marketingConsent=false`；Email Center 的退订、退信、投诉及抑制始终有效。普通资料保存和邮箱变更不能恢复退订。
- 本网站没有团队邀请、运营管理页面或管理员 API。内部个人账单身份保持原样；排查与恢复使用现有 MCP、日志、任务记录和脚本。

## 邮箱变更流程

1. 在账户页主动确认当前邮箱归属。注册和登录仍不发送邮箱验证码，也不强制邮箱确认。
2. 提交新邮箱和当前密码。服务端要求有效登录、15 分钟内的登录会话、当前邮箱已确认及同源请求。
3. `/api/auth/account/request-email-change` 调用 Better Auth 原生密码校验和 `changeEmail`。原生 HTTP `/api/auth/change-email` 被禁用，不能绕过额外校验。
4. 原邮箱先收到一小时内有效的批准链接。点击后向新邮箱发送一小时内有效的归属确认链接。回跳固定为本站账户页。
5. 新邮箱确认后，Better Auth 才修改原用户的邮箱，用户 ID、账单和返佣身份保持不变。确认前不修改邮箱，也不提前解绑 Email Center 联系人。
6. 数据库触发器在同一事务中撤销该用户所有登录会话。用户需要用新邮箱重新登录；确认请求写回的旧会话 Cookie 也无效。
7. 原有联系人触发器产生下一版本事件，Worker 同步新邮箱。Email Center 解绑并停止旧地址的投递，退订抑制随原用户身份保留。

密码、令牌、会话仍由认证库管理，未引入新的身份系统。实施依据：[Better Auth 用户与账户](https://better-auth.com/docs/concepts/users-accounts)、[原生数据库限流](https://better-auth.com/docs/concepts/rate-limit)、[OWASP 邮箱变更指引](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#changing-a-users-registered-email-address)。

## 失败与限制

- 事务邮件功能关闭、发件人或服务端 Key 未配置时，不显示可用的变更表单，API 也不发送请求。
- 错误密码、过期会话、未确认邮箱、非同源请求以及超限尝试均被拒绝。
- Better Auth 使用 PostgreSQL 共享 IP 限流；另外使用同一张限流表原子记录每账户 15 分钟最多 5 次尝试，换 IP 和并发请求不能增加密码尝试预算。生产反向代理必须正确处理客户端 IP，不能接受用户伪造的代理头。
- Better Auth 对已占用地址和邮件发送失败都给出中性回执，HTTP 200 不代表邮件已送达或邮箱已变更。界面提示“请求已接收”，允许稍后重新申请；邮件错误留在服务端日志。
- 变更令牌重放不会再次修改身份：完成后原地址已不再匹配令牌所属用户。数据库唯一约束也阻止两个账户共用一个邮箱。
- 开发日志忽略含验证或重置令牌的请求 URL。生产代理和平台访问日志也需隐藏令牌与敏感查询参数。
- 本轮未实现退订后的显式重新授权流程。偏好复选框只保存意愿，不绕过 Email Center 抑制。

## 数据库与配置

新增 migration `0017_soft_mindworm.sql`：Better Auth `rateLimit` 表、邮箱更新时撤销登录会话的触发器。使用 `npm run db:migrate` 单独迁移，开发启动不隐式迁移。

复用 `FEATURE_TRANSACTIONAL_EMAIL`、`RESEND_API_KEY`、`EMAIL_FROM` 和 `APP_BASE_URL`，没有新增生产凭据。`TRANSACTIONAL_EMAIL_API_URL` 仅允许本地模拟服务覆盖地址，生产禁止使用。真实 Resend 发件域名、投递及生产配置尚未验证。

## 本地验证

启动本地 SaaS、Email Center 和 `scripts/mock-transactional-mail-server.mts`。SaaS 测试进程临时启用事务邮件，并把适配器指向 `http://127.0.0.1:4871/emails`；不得把模拟 Key 写入正式环境。

```powershell
$env:FEATURE_TRANSACTIONAL_EMAIL='true'
$env:FEATURE_TURNSTILE='false'
$env:TRANSACTIONAL_EMAIL_API_URL='http://127.0.0.1:4871/emails'
npm run smoke:account-settings:live
```

该测试只允许本机数据库/服务和专属 Email Center 测试 Key，清理本轮创建的账户与联系人。覆盖资料/语言/意愿同步、未确认邮箱保护、实际退订请求、两邮箱链接、错误密码、近期认证、Origin、外部回跳、会话撤销、令牌重放、新邮箱登录、已占用地址中性回执、邮件服务故障、跨 IP 并发账户限流，以及变更后的抑制与旧地址解绑。邮件只进入本地模拟服务，不向真实收件人发送。

2026-10-03 本机验证记录：`typecheck`、生产构建、上述完整 HTTP 冒烟、既有认证/邮箱确认/密码重置冒烟通过；`0017` 升级迁移通过。全部 18 个版本化迁移另在一次性空数据库中执行成功，核对 21 张业务/认证表及会话撤销触发器后移除了该测试数据库。关闭事务邮件的启动模式也已验证：变更 API 返回 503、页面不提供表单、原生及编码路径入口返回 404、超大请求体返回 413。浏览器验证了中文保存、邮件语言与意愿的持久化、原邮箱确认后的变更表单、中文错误密码提示与密码清除，以及英文深色手机宽度下无横向页面溢出。一次性账户、联系人和本轮服务进程已清理。以上是本地开发验证，不代表真实邮件投递或生产部署。
