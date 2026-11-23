# AI Personal Book Editor

**一本书进去，AI 为你重编成新书。**

把一本无 DRM 的 EPUB 交给 AI：它先读完整本书，逐章判断哪些该按你的阅读画像重写、哪些该压成一页提要、哪些整章删掉，再逐章改写、重新命名和排序，最后导出成一本能直接读的新 EPUB。原书只读，所有改写都发生在副本上。

这是一个可以自己部署的完整产品，不是 SDK：自带账户体系、书库、改写流水线、EPUB 导出和六种语言的界面；计费、返佣和邮件集成按需开启，不配置也能完整使用核心功能。

> **English** — AI Personal Book Editor turns one EPUB into a better book. An LLM reads the whole book, decides chapter by chapter whether to rewrite, condense or drop each one for a given reader profile, then rewrites, renames and reorders the chapters and exports a new EPUB. It is a self-hosted Next.js 16 + PostgreSQL application with accounts, a per-user library, six UI languages and optional billing/email integrations. Full English summary at the [end](#english).

---

## 它做什么

1. **导入 EPUB** — 拖进书库。原文件只读，一个字节都不改。
2. **生成整理方案** — AI 读完整本书，逐章给出价值判断和处理方式（重写 / 提要 / 删除 / 保留），并说明理由。
3. **确认并改写** — 你可以逐章改判，然后开始改写；进度、评分和保留理由全程可见，中途可以停下，之后接着跑。
4. **导出成品** — 一键导出新的 EPUB，书首自动带上「怎么读这本书」。目录、图片和图注按原书结构保留。

## 主要功能

| 功能 | 说明 |
| --- | --- |
| 书库 | 每个账号一个独立目录，按会话校验归属 |
| 整理方案 | 整本书级别的章节取舍，可逐章改判 |
| 逐章改写 | 按阅读画像调整讲法、压缩水分、重排章节 |
| 阅读画像 | 记录你的背景、目标和偏好，作为改写的依据；支持粘贴 AI 回答导入 |
| 自定义提示词 | `prompts/` 下的模板可改，界面里也能调整 |
| 模型接入 | OpenAI 兼容接口，内置 OpenAI / DeepSeek / OpenRouter / SiliconFlow / Ollama / LM Studio 预设，也可填任意中转 |
| EPUB 导出 | EPUB3、分层目录、图片与原书内链保留 |
| 多语言界面 | English、简体中文、日本語、Deutsch、Español、Français |
| 账户体系 | 邮箱 + 密码，注册需邮箱验证码；可选 Google / GitHub 登录、Cloudflare Turnstile |
| 可选集成 | 计费（外部 Payment Center）、返佣与提现、邮件中心，默认全部关闭 |

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Next.js 16（App Router）、React 19、TypeScript strict |
| 样式 | Tailwind CSS 4 |
| 数据库 | PostgreSQL 17、Drizzle ORM |
| 认证 | Better Auth |
| 国际化 | next-intl（六种语言，键集合必须一致，有测试卡着） |
| 校验 | Zod |
| 测试 | Vitest、Playwright |

## 快速开始

前置条件：Node.js 22 以上；PostgreSQL 17（本机安装或用 Docker）。

```bash
npm install

# 从 .env.example 生成 .env，并自动生成本地密钥
# （BETTER_AUTH_SECRET / CRON_SECRET / INTEGRATION_ENCRYPTION_KEY_V1）
# 已存在的 .env 永远不会被覆盖
npm run setup
```

准备数据库，二选一：

```bash
# A. Docker：容器开在 127.0.0.1:54329
npm run db:up
#   然后把 .env 里的 DATABASE_URL 改成：
#   postgresql://saas_framework:saas_framework@127.0.0.1:54329/saas_framework

# B. Windows / PowerShell，用本机 PostgreSQL（127.0.0.1:5432）
npm run db:local:up
```

建表并启动：

```bash
npm run db:migrate
npm run db:seed      # 只校验表结构和功能开关，不写任何数据
npm run dev          # http://localhost:3000
```

### 注册需要一个邮箱发送服务

注册流程是「先发验证码、再建会话」，所以本地也要有能真正发信的通道，否则注册接口会返回 503（这是有意为之，见 `lib/auth.ts`）。在 `.env` 里填三项即可，Resend 免费档就够：

```bash
FEATURE_TRANSACTIONAL_EMAIL=true
RESEND_API_KEY=re_...
EMAIL_FROM="AI Personal Book Editor <noreply@your-domain>"
```

### 第一次使用

注册 → 登录 → 书库导入一本 EPUB → 打开「AI 模型设置」填自己的模型接口和 Key → 生成整理方案 → 改写 → 导出。

模型费用由你的模型服务商直接收取，本项目不经手；本站自己的订阅（如果启用了计费）是另一笔账。

## 环境变量

`npm run setup` 会生成 `.env`，其余按需填写。完整注释见 `.env.example`。

**核心（必填）**

| 变量 | 用途 |
| --- | --- |
| `APP_BASE_URL` | 站点公开地址（生产必须是真实 HTTPS 根地址）；同源检查、回跳和 SEO 都用它 |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `BETTER_AUTH_SECRET` | 会话签名密钥，`npm run setup` 自动生成 |

**邮件**

| 变量 | 用途 |
| --- | --- |
| `FEATURE_TRANSACTIONAL_EMAIL` | 打开事务邮件（注册验证码、找回密码） |
| `RESEND_API_KEY` / `EMAIL_FROM` | Resend 的 Key 和发件人 |

**登录增强（可选）**

| 变量 | 用途 |
| --- | --- |
| `FEATURE_TURNSTILE` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` / `TURNSTILE_ALLOWED_HOSTNAMES` | Cloudflare Turnstile 人机挑战 |
| `FEATURE_GOOGLE_OAUTH` + `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google 登录 |
| `FEATURE_GITHUB_OAUTH` + `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub 登录 |

**可选集成（默认关闭）**

| 变量 | 用途 |
| --- | --- |
| `FEATURE_PAYMENT_CENTER` + `PAYMENT_CENTER_*` | 接外部 Payment Center 收款；该服务不在本仓库，不配置时定价页显示「未连接」，其余功能不受影响 |
| `FEATURE_REFERRALS` / `FEATURE_REFERRAL_WITHDRAWALS` / `FEATURE_COMMISSION_BALANCE` | 邀请返佣与提现，依赖 Payment Center |
| `FEATURE_EMAIL_CENTER` + `EMAIL_CENTER_*` | 联系人同步与退订管理 |
| `CRON_SECRET` | 内部 cron 接口的 Bearer 令牌，`npm run setup` 自动生成 |
| `INTEGRATION_ENCRYPTION_KEY_V1` | 提现收款账户的 AES-256-GCM 加密密钥 |

> 所有密钥只放在被忽略的 `.env` 或部署平台的环境变量里；仓库里没有任何真实凭据。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` / `build` / `start` | 开发、构建、生产启动 |
| `npm run lint` / `typecheck` | ESLint、`tsc --noEmit` |
| `npm test` | Vitest（每个测试文件一个隔离数据库） |
| `npm run test:engine` | 书稿引擎的 node:test 套件 |
| `npm run test:e2e` | Playwright |
| `npm run db:generate` / `db:migrate` / `db:studio` | Drizzle 迁移 |
| `npm run db:up` / `db:down` | Docker 开发数据库 |
| `npm run seed` | 校验数据库构建与功能开关（不写数据） |
| `npm run worker` | 手动跑一轮后台任务（邮件同步、对账等） |
| `npm run email:loop` / `payment:reconcile` | 常驻邮件循环 / 支付对账兜底 |
| `npm run smoke` | 冒烟套件；live 套件需显式 `--live=NAME` 才跑 |

## 目录结构

```
app/[locale]/          页面（落地页、定价、书库、工坊、设置…）
app/api/               接口：books / rewrite / providers / profile / auth / …
lib/book-engine/       书稿引擎：EPUB 读写、分章、提示词、LLM 调用、导出
lib/book-store/        按用户隔离的存储层（默认 ./data）
lib/auth.ts            登录、注册、验证码（Better Auth）
lib/billing/           订阅与支付意图（可选）
lib/payment-center/    支付中心适配（可选）
lib/email-center/      联系人同步（可选）
lib/referrals/         邀请、返佣、提现（可选）
messages/              六种语言的界面文案
prompts/               改写与整理方案的提示词模板
scripts/ops/           运维脚本：迁移、同步、worker、对账
tests/                 Vitest 与 Playwright
```

## 部署

- 运行环境：Node.js 22；先 `npm ci && npm run build`，再用 `npm start`（默认 3000 端口）。
- 首次部署执行 `npm run db:migrate`；升级时同样先迁移再切流量。
- `APP_BASE_URL` 必须设成外部可访问的 HTTPS 地址，登录的同源检查靠它，写错会把自家页面判成外站。
- **`data/`（或 `BOOK_STORAGE_ROOT` 指向的目录）必须挂持久卷**：书稿、中间产物、模型配置和阅读画像都在里面，容器重建不丢。
- 需要后台同步时再开常驻进程（`npm run worker`、`npm run email:loop`），否则可以只跑 Web。
- 健康检查：`GET /api/health`（存活）、`GET /api/ready`（依赖就绪）。

## 数据与隐私

- 原书只读，改写结果单独存放，导出另存一本。
- 书库按账号隔离：`data/users/<userId>/`，接口按会话校验归属。
- 模型 API Key 存在 `data/users/<userId>/config/providers.json`，接口返回一律打码。
- 本仓库不收集任何遥测；除你自己配置的模型接口、邮件服务和可选计费服务外，不会向外发送数据。

## 许可证与来源

MIT，见 [LICENSE](LICENSE)。

项目起点是 Vercel 的 [nextjs/saas-starter](https://github.com/nextjs/saas-starter)（MIT），固定的上游提交与许可声明见 [NOTICE.md](NOTICE.md)。其后的书籍引擎、认证、计费、国际化等代码在本仓库维护。

---

## English

**AI Personal Book Editor** turns one EPUB into a better book.

An LLM reads the whole book first, then decides chapter by chapter what to do with each one for a given reader profile: rewrite it in a clearer voice, condense it into a one-page digest, drop it entirely (copyright pages, recommendation prefaces), or keep it as is. It then rewrites, renames and reorders the chapters and exports a new EPUB 3 with the original table-of-contents hierarchy, images and internal links preserved. The source file is never modified.

It is a complete, self-hostable product rather than an SDK:

- **Stack** — Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, PostgreSQL 17 with Drizzle ORM, Better Auth, next-intl (English, 简体中文, 日本語, Deutsch, Español, Français), Vitest and Playwright.
- **Book engine** — EPUB parsing and writing, chapter planning, per-chapter rewriting against a reader profile, resumable runs, EPUB 3 export.
- **Model access** — any OpenAI-compatible endpoint; presets for OpenAI, DeepSeek, OpenRouter, SiliconFlow, Ollama and LM Studio. You bring your own key and pay the provider directly.
- **Optional integrations** — billing through an external Payment Center service (not part of this repository), referral commissions and withdrawals, and an email contact centre. All are off by default; the book features work without them.
- **Accounts** — email and password with a mailed one-time code, plus optional Google/GitHub sign-in and Cloudflare Turnstile.

### Getting started

```bash
npm install
npm run setup            # creates .env with freshly generated local secrets
npm run db:up            # Docker Postgres on 127.0.0.1:54329 (point DATABASE_URL there)
npm run db:migrate
npm run dev              # http://localhost:3000
```

Registration sends a one-time code, so a transactional email sender is required even locally: set `FEATURE_TRANSACTIONAL_EMAIL=true`, `RESEND_API_KEY` and `EMAIL_FROM`. Without them the registration endpoints answer 503 by design.

### Deployment notes

Run `npm run build` then `npm start` on Node.js 22. Apply migrations (`npm run db:migrate`) before serving traffic. Set `APP_BASE_URL` to the public HTTPS origin. Mount `data/` (or `BOOK_STORAGE_ROOT`) on a persistent volume — books, generated artefacts, model settings and reader profiles live there.

Licensed under the MIT License; see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for the upstream `nextjs/saas-starter` provenance.
