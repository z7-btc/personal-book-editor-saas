# Email Center 接收凭据与恢复

## 范围与权威

Email Center 管理联系人、营销授权、退订及投递抑制。本站保存用户资料和营销意愿，使用持久队列同步；对账不会改变远端联系人或授权。诊断使用日志、队列表和现有 MCP，没有运营管理页面、管理 API 或新增管理员角色。

中心新增 `POST /api/v1/contacts/reconcile`，使用应用服务端 Bearer Key。请求体包含原 `idempotencyKey` 和原 contact 请求；不能把邮箱、姓名或 Key 放进 URL。中心复用 upsert 的验证规则与请求指纹，按当前应用查询 ingestion 收据和 externalUserId 绑定，在只读一致快照中读取结果。响应只返回接收状态、匹配标记和授权状态，不返回原邮箱、姓名、请求哈希或 metadata；成功和错误均 `Cache-Control: no-store`，请求上限 20,000 字节。

`POST /api/v1/integrations/verify` 返回 `capabilities.contactReconciliation="v1"`。本站 readiness 要求这项能力，因此升级时先部署 Email Center，再迁移并部署本站；旧中心不能冒充已具备完整恢复契约。

## 自动处理

- 首次发送使用 `saas:contact:<userId>:v<eventVersion>`；重试先查询同一键和请求，确认中心未接收后才补发。查询失败不能被解释为未接收。
- 收据与请求、当前身份绑定一致：本地标为 `succeeded`，不重发。已退订/被抑制记为 `AUTHORITY_SUPPRESSED`，其他远端偏好变化记为 `REMOTE_PREFERENCE_CHANGED`，均尊重中心状态。
- 请求指纹冲突、收据失败或绑定漂移：记录诊断码。尚未确认的发送进入 `dead_letter`；历史成功记录保留成功事实并标记当前漂移，不自动覆写远端。
- 网络错误、408、429、5xx 按 Retry-After 或指数退避重试；普通 4xx、协议或配置冲突停止自动发送。八次尝试后发送进入 `dead_letter`；暂时失败的接收结果仍可只读查询。
- 发送和对账共享每用户互斥约束，各自使用 30 秒 lease；短事务领取后释放行锁再访问 HTTP。过期 lease 可回收，新事件版本不会借用旧幂等键。对账不增加发送次数。
- 已成功和结果未知的最新事件安排后续查询；永久查询错误暂停自动查询，修好配置后可按原编号手动检查。远端发生变化时只记录差异，不重新授权或生成新请求键。

## 运行方式

环境变量继续使用 `FEATURE_EMAIL_CENTER`、`EMAIL_CENTER_URL`、`EMAIL_CENTER_API_KEY`。开发默认 `RECOVERY_RUNNER_MODE=manual`；`npm run dev` 不运行任务。

```sh
npm run email:sync
npm run email:reconcile
npm run email:loop
```

独立常驻循环空队列每五秒检查一次，积压立即继续处理，并每分钟进行一批有界对账。原 worker 优先处理待发送任务，对账也有时间预算。生产须实际测量正常注册 30 秒内到达及故障恢复后的积压清空，不能以本地构建代替时效验收。

HTTP 调度使用 `RECOVERY_RUNNER_MODE=cron` 和至少 32 字符的 `CRON_SECRET`：

```text
GET /api/internal/email-center/sync
GET /api/internal/email-center/reconcile
Authorization: Bearer <CRON_SECRET>
```

支持 GET/POST；每次最多 25 项、20 秒批处理预算，远端查询超时四秒。接口只按已保存的到期任务执行，忽略 URL/body 中的用户或强制重试参数。发送调度需满足不超过十秒的轮询间隔；对账可独立每分钟调度。默认不开启 HTTP 入口。

## 按原操作恢复

通过现有 MCP 查看 `email_contact_outbox` 的状态、事件版本、尝试次数、`last_error_code`、`last_reconcile_code`、`last_reconciled_at` 和下次对账时间。日志及命令输出不得包含邮箱、Key、Cookie、原请求体或完整数据库连接。

先修复服务/凭据问题，再查询原用户与版本：

```sh
npm run email:reconcile -- --user-id <原用户ID> --event-version <原版本> --force
```

只有中心确认原请求未接收、该事件仍是最新 `dead_letter` 且没有活动 lease 时，以下显式命令才把同一记录放回待发送队列：

```sh
npm run email:reconcile -- --user-id <原用户ID> --event-version <原版本> --retry
npm run email:sync
```

已接收的请求仅确认成功；冲突、失联和过时事件不会重排。重排保留原事件 ID、键、发生时间与累计尝试次数，仅允许额外一次发送；不清空历史、不自动续开重试预算。命令记录操作指纹、动作与计数，队列表记录 `MANUAL_RETRY_REQUESTED`。不用创建第二个用户或请求键来绕过冲突。

## 数据库与时区

迁移 `0018` 添加对账状态、独立 lease 和每用户活动互斥索引；`0019` 把邮件队列的发生时间、可执行时间、lease 及创建/更新时间迁为 `timestamptz`，使 Asia/Shanghai 等非 UTC 数据库中的退避和过期判断正确。

升级前停下队列 runner。旧未发送事件按迁移连接的原数据库时区解释；已尝试事件按旧 Node runner 读取无时区日期时的时区转换，以保留原来的 ISO 请求时间和接收指纹。旧 settle 写入的 UTC 可执行时间与 SQL 创建的时间分别转换。迁移连接保持旧数据库原时区；如果旧 Node runner 与数据库时区不同，在迁移连接的 URL 参数中显式设置，例如 `options=-c%20saas.legacy_email_runner_timezone%3DUTC`。不要把带凭据的完整连接串写进日志或文档。已尝试旧事件的历史时间可能曾有偏移，保留它是为查询原接收凭据，不据此生成新授权。

## 本地验证与上线门槛

```sh
npm run smoke:email-sync
npm run smoke:email-reconcile:live
npm run smoke:email-reconcile:http
npm run smoke:email-timezone-migration
```

第二项要求空的本地 SaaS 测试库、运行中的本地 Email Center 和本机数据库；使用独立临时应用、合成联系人和实际退订端点，结束后清理。中心自身的真实数据库契约测试为 `tests/contact-reconcile.integration.test.ts`，通过 `RUN_DB_INTEGRATION_TESTS=1` 运行。时区迁移脚本 `scripts/smoke-email-timezone-migration.mts` 在两个独立临时库验证 clean/upgrade/repeat 路径。

本地测试不代表生产部署、实际同步时效或邮件投递已经通过；重新同意营销订阅仍需独立的明确同意证明，普通资料同步和对账不会重新开启退订授权。

### 2026-10-04 本地记录

- 真实 PostgreSQL + Email Center HTTP：20 场景通过，含已接收响应丢失、原键查询/补发、实际签名退订、冲突、手动恢复、并发/崩溃/版本顺序、非 UTC 退避及真实慢 HTTP 的批次超时。
- 中心接收契约：10 项真实数据库测试通过，含应用隔离、只读快照、请求匹配、体积限制、读流中断、no-store、退订和能力检查。
- 定时入口：GET/POST 鉴权、空报告、忽略外部重排参数、实际 v1 readiness 通过；manual 模式即使携带正确密钥仍返回 503，取消的组织与 admin 入口仍为 404。
- 迁移：20 条 clean/upgrade/repeat、八个时区字段、活动互斥约束通过；旧 Node 与数据库同为 Asia/Shanghai，以及旧 Node UTC/数据库 Asia/Shanghai，均保留已尝试事件的原请求指纹。
- 所有合成用户、联系人、独立测试应用、两个迁移数据库和临时慢 HTTP 服务已清理；没有发送真实邮件或部署生产。
- 两个项目的类型检查与生产构建、中心 lint 和全部 31 项测试通过；本站基础认证及真实注册/语言/营销选择/邮箱换绑同步回归通过。五项既有付款/权益 smoke 在纳入 `.mts` 类型检查后继续通过。
