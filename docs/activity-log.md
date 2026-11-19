# 个人活动记录与最小审计

## 范围

`/dashboard/activity` 和 `GET /api/account/activity` 只展示当前 Better Auth 用户本人的活动。没有运营管理页面、管理员角色、全站查询、任务重排或浏览器任务重试按钮。

记录从正式活动迁移应用后开始，不伪造历史数据，不显示未经查询的总数。页面显示“已显示 N 条”，使用游标加载更早记录；时间明确采用 UTC。

## 事实来源

表定义为 `lib/db/activity-schema.ts`，触发器草案为 `docs/activity-migration.sql`。主代理负责将表加入现有 Drizzle schema、生成正式迁移、审阅触发器并应用。这个文档和脚本不会自动执行迁移。

| 事件 | 绑定的数据库事实 |
| --- | --- |
| 注册 | canonical `user` 插入 |
| 资料或邮件偏好更新 | 姓名、邮件语言来源或营销偏好字段实际改变 |
| 邮箱变更与确认状态 | `user.email/email_verified` 实际改变 |
| 密码更新 | credential `account.password` 实际改变 |
| 会话建立 | canonical `session` 插入，注册和邮箱确认也可能建立会话 |
| 付款请求 | `payment_intents` 插入且账单账户归属匹配 |
| 付款确认、冲正、恢复 | 匹配本人归属、账单组织、中心订单和币种的 `payment_evidence` 事实与状态改变 |
| 服务授权、撤回、恢复 | 上述付款关联及组织、产品、方式、周期、provider subscription、证据状态均匹配的 `subscription_grants` 事实 |

触发器记录与源事实同一事务提交，源事务回滚时活动也回滚。同状态写入不重复记录；数据库 `(user_id, operation_key)` 唯一约束阻止重放。变化操作使用内部实体标识与事务标识作为幂等键。

活动页面没有把“会话建立”描述为“密码登录成功”，没有把会话清理描述为“主动退出”。失败登录、退出登录、重置链接请求等完整认证审计仍需要明确的认证 hook 及对应验证；本模块不声称已自动记录所有认证行为。未匹配有效付款事实的 inbox 消息也不会被标记为退款成功。

## 权限与隐私

DAL 从当前会话取得用户身份，不接收浏览器用户 ID 或组织 ID。接口忽略这些查询参数；查询始终包含本人 `user_id` 条件。HMAC 游标绑定本人及首次分页上界，不能跨用户使用；新记录不扰乱已开始的分页。

产品 DTO 仅包含记录编号、固定事件类型、类别及 ISO 时间。不会返回内部用户 ID、操作键、实体 ID、邮箱、姓名、IP、Cookie、会话 token、钱包、付款 instrument 或原始请求。

表中没有任意 metadata 或原始正文。内部用户和业务实体标识仍用于可信关联。删除用户时 `user_id` 置空；最小内部操作键、实体引用和事件事实仍被保留，属于金融与安全审计保留。这里尚未实现全生命周期匿名化、留存期限清理或密钥轮换流程，不能将用户删除称为全部关联信息已清除。

## 日志

`lib/observability/logger.ts` 只输出固定 event/code、时间、数量、耗时、活动编号及可选 64 位摘要。额外字段全部丢弃；没有 `message/error/request/headers/userId/email/wallet/url` 输出通道。错误 API 返回固定错误码，不记录数据库异常正文或参数。

这种白名单方法遵循 [OWASP Logging Cheat Sheet 的敏感数据排除原则](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude)。已有其他模块的所有日志尚未统一改接本 logger，因此不能声称全项目日志均已脱敏。

## 验证命令

```powershell
node --conditions=react-server --import tsx scripts/smoke-activity-boundaries.mts
```

纯边界验证不会访问数据库或服务，覆盖游标签名、跨用户拒绝、篡改、签名密钥变化、日志额外字段剔除、实际输出及 `en` 与 `zh-CN` 两份事件键（该脚本尚未扩到其余四种站点语言）。

正式迁移与当前本地 Next 服务准备好后，再执行 HTTP/数据库活动 smoke；测试使用随机合成用户，验证本人分页、事务回滚与活动事实，随后清理自己创建的数据。不会发送真实邮件或付款。
