# 第三方登录：Google 与 GitHub

## 目标

登录页与注册页增加「用 Google 登录」「用 GitHub 登录」两个按钮，让用户不必记忆本站密码就能注册和登录。

代码侧的接线量很小：`saas-framework` 已经装了 Better Auth，它内置了完整的 OAuth 授权码流程、`state` 校验与账号关联策略。本次**不实现 OAuth 协议本身**，只做三件事——把 provider 接进认证实例、在页面上渲染按钮、把失败路径变成看得懂的中英提示。

## 范围

**只修改 `saas-framework`。其它项目零改动。**

不做的事：

- **不接入 X（Twitter）**。它的邮箱权限需要单独申请，且强制 HTTPS 回调，本地无法联调。留作后续独立任务。
- **不新增「给第三方账号补设密码」页面**。Better Auth 的 `/reset-password` 在目标账号没有 credential 记录时会**新建**一条（`node_modules/better-auth/dist/api/routes/password.mjs:161`），所以现有的「忘记密码」页面本来就是这条路；本次只在文案上引导，不新增页面。
- 不改动邮箱注册/登录、验证码、Turnstile、推荐码、账号设置、组织（organization）的任何现有行为。

## 前置条件（运营者）

代码可以先写完、先跑自动化测试；但**真实联调**需要下面两对凭据，它们只能由运营者在自己的账号里创建。

| 凭据 | 在哪里创建 | 关键填写项 |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud Console → 已有项目 `Gemini Project` → 先填写「OAuth 权限请求页面」→「凭据」→「创建凭据」→「OAuth 2.0 客户端 ID」，类型选「Web 应用」 | 已获授权的重定向 URI：`http://localhost:3000/api/auth/callback/google`，以及生产域名下的同一路径 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub → Settings → Developer settings → OAuth Apps → New OAuth App | Authorization callback URL 同上规则，把路径里的 `google` 换成 `github` |

三个必须提前知道的坑：

1. **Google 默认停在「测试」状态**，只有被加进白名单的账号能登录。对外开放必须在「OAuth 权限请求页面」点「发布应用」。这个坑的表现很阴：自己测一切正常，用户全登不进来。
2. **发布需要隐私政策链接**。本站 `/zh-CN/privacy`、`/en/privacy` 路由已存在，但按 `docs/legal-pages.md` 的描述默认是未完成的草稿（页面显示缺失项、`noindex, nofollow`）。技术上不阻塞联调，上线前必须补齐。
3. 本次只申请 `openid` / `email` / `profile` 这类**非敏感权限**，Google 不触发人工审核，发布后立刻可用。

## 设计决策

### 用 Better Auth 内置 provider，不自己实现 OAuth

Better Auth 已内置 Google 与 GitHub 的授权码流程、`state` 校验、`account` 表落库与账号关联策略。手写等于重复实现这些，且更容易在 `state`、重定向校验上出错。

### 凭据缺失时隐藏按钮，而不是点了报错

沿用 `lib/config.ts` 现有的 capability 机制（`capability(enabled, required)`：开关打开且必需变量都非空才算 `configured`）。按钮只在 `configured` 为真时渲染，本地没配钥匙时页面退化回今天的纯邮箱密码形态，不会出现「点了没反应」。

### 同名邮箱自动关联到既有账号

Better Auth 的默认行为（`account.accountLinking.enabled` 未显式关闭即为开启）就是：第三方返回的邮箱已验证、且本地账号的邮箱也验证过时，自动把第三方账号挂到既有用户上。本站注册路径本来就强制邮箱验证，因此这个默认是安全的——能合并的人必须先控制那个邮箱。**本次不做任何覆盖配置。**

### 给 provider 打开 `requireEmailVerification`

这是本次唯一一处非默认的 provider 配置，专门用来处理「GitHub 用户把邮箱设为私有且主邮箱未验证」。

不加这个配置时，这类用户的路径是：账号**已经建出来**（`emailVerified: false`）→ 创建会话 → 撞上本站 `lib/auth.ts:76` 的会话闸门（未验证邮箱禁止建会话）→ 抛 `APIError FORBIDDEN`，浏览器停在回调地址上看到一段原始报错，且**没有密码可以走「忘记密码」**，等于死胡同。

打开后，Better Auth 在 `node_modules/better-auth/dist/oauth2/link-account.mjs:314` 就会在**建会话之前**拦下，把用户重定向到我们指定的错误页，带一个可读的错误码。用户看到的是人话，不是堆栈。

## 实现

### 一、`lib/auth.ts`：接入两个 provider

在 `betterAuth({...})` 里新增 `socialProviders`，写法沿用同文件 `captcha` / `emailOTP` 已有的「用 `getCapabilities()` 就地判断」惯例：

```ts
socialProviders: {
  ...(getCapabilities().googleOAuth.configured ? {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
      requireEmailVerification: true,
    },
  } : {}),
  ...(getCapabilities().githubOAuth.configured ? {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
      requireEmailVerification: true,
    },
  } : {}),
},
```

GitHub 的邮箱取法不用额外配置：Better Auth 的 provider 默认申请 `read:user` + `user:email`，并在拿不到公开邮箱时自动请求 `https://api.github.com/user/emails`，取 primary 优先，同时带回 `verified` 标记（`node_modules/@better-auth/core/dist/social-providers/github.mjs:15,71-83`）。

`emailVerification.sendOnSignUp` 在 `auth.config.ts` 里是显式的 `false`，所以上面那条 `requireEmailVerification` 分支**不会**触发 Better Auth 自带的验证邮件发送（`??` 只对 `null`/`undefined` 生效）。本站的邮箱验证走自己的验证码流程，不受影响。

### 二、两个页面把「有哪些 provider 可用」传给组件

`app/[locale]/(login)/sign-in/page.tsx` 与 `sign-up/page.tsx` 已经是服务端组件且已调用 `getCapabilities()`。各增加一个 `socialProviders` prop：

```ts
const capabilities = getCapabilities();
const socialProviders = [
  ...(capabilities.googleOAuth.configured ? ['google' as const] : []),
  ...(capabilities.githubOAuth.configured ? ['github' as const] : []),
];
```

### 三、新组件 `components/auth/social-sign-in.tsx`

沿用 `components/auth/` 的现有习惯（`turnstile-widget.tsx`、`password-reset-flow.tsx` 都是该目录下的小客户端组件）。职责三件：

1. 每个可用 provider 渲染一个按钮；
2. 点击后调 `authClient.signIn.social({ provider, callbackURL, errorCallbackURL })`，期间禁用按钮并显示「正在跳转…」；
3. 把 `error` prop 映射成本地化文案。

跳转地址两条**都必须带语言前缀**。本站 `i18n/routing.ts` 配的是 `localePrefix: 'always'`，语言永远在 URL 里；不带前缀会被中间件再跳一次，而且中间件按 `Accept-Language` 猜语言，可能把中文用户甩到英文页。

```ts
const callbackURL = `/${locale}/dashboard`;
const errorCallbackURL = `/${locale}/sign-in`;
```

`errorCallbackURL` 是必需的：不传时 Better Auth 回落到它自带的 `${baseURL}/error`（`node_modules/better-auth/dist/api/routes/callback.mjs:35`），那是一张与本站风格无关的页面。

### 四、`login.tsx`：放到表单上方

在 `<form>` 之前渲染：

```
<SocialSignIn providers={socialProviders} error={socialError} />
────────  或  ────────
<form>…邮箱密码…</form>
```

分隔线只在 `socialProviders.length > 0` 时渲染。`Login` 增加两个 prop：`socialProviders`、`socialError`。

`socialError` 只由**登录页**（`sign-in/page.tsx`）从 `searchParams` 读出后传入——`errorCallbackURL` 指向的就是登录页。注册页不读这个参数，其 `socialError` 传 `undefined`。Next 16 的 `searchParams` 是 Promise，页面需要 `await`。

### 五、错误码到文案的映射

Better Auth 在回调失败时会重定向到 `errorCallbackURL` 并附上 `?error=<短码>`（`node_modules/better-auth/dist/oauth2/errors.mjs:9`）。未识别的值一律回落到通用文案。

| `?error=` | 含义 | 文案要点 |
|---|---|---|
| `email_not_verified` | 第三方邮箱未验证（本次最主要的场景） | 让他去第三方把邮箱验证掉，或者改用邮箱注册 |
| `email_not_found` | 第三方根本没给邮箱 | 同上，措辞改为「没有提供邮箱」 |
| `email_does_not_match` | 关联时两边邮箱不一致 | 提示改用原来的方式登录 |
| `account_already_linked_to_different_user` | 该第三方账号已绑给别的用户 | 提示该账号已被占用 |
| `unable_to_link_account` | 关联失败 | 通用失败文案 |
| `unable_to_get_user_info` / `no_code` / `invalid_state` / `state_not_found` | 流程中断或校验失败 | 通用失败文案，建议重试 |
| 其它（含第三方侧取消授权的 `access_denied`） | 未知 | 通用失败文案 |

### 六、文案

`messages/en.json` 与 `messages/zh-CN.json` 的 `Login` 命名空间新增：

`socialGoogle`、`socialGithub`、`socialOr`、`socialPending`、`socialErrorEmailNotVerified`、`socialErrorEmailNotFound`、`socialErrorEmailMismatch`、`socialErrorAccountTaken`、`socialErrorLinkFailed`、`socialErrorFlow`、`socialErrorGeneric`。

中英两侧都必须补齐，英文侧不得含 CJK（`tests/i18n.test.ts` 的既有规矩）。

### 七、`.env.example` 补文档

代码里 `FEATURE_GOOGLE_OAUTH` / `FEATURE_GITHUB_OAUTH` 与四个凭据变量已经能被读取，但 `.env.example` 里**一个字都没有**。按该文件既有的三段式（默认值 / 用途 / 获取生成）补两段。

## 不改什么

- `db:generate` / 数据库结构。`account` 表已有 `accountId`、`providerId`，OAuth 落库不需要新表新列。
- `app/api/auth/[...all]/route.ts` 的路由守卫。回调路径 `/api/auth/callback/google` 不在 `isUnavailableRoute` 与 `turnstileEndpoints` 的名单里，无需改动。
- `auth.config.ts`（schema 生成器用的无数据库实例）。它只服务 `better-auth` 的 schema 生成，不参与运行时。
- 推荐码。`components/auth/referral-claim.tsx` 在 dashboard 页自动发起认领，第三方登录的用户落到 dashboard 同样会被认领。

## 边界情况

| 情况 | 行为 |
|---|---|
| 本地没配钥匙 | 按钮不渲染，页面与今天完全一致 |
| 只配了 Google | 只渲染 Google 按钮，分隔线照常 |
| 用第三方登录，邮箱与既有邮箱账号相同且两边都已验证 | 自动关联，直接进老账号 |
| 用第三方登录，邮箱未验证 | 拦在 `requireEmailVerification`，重定向到 `/{locale}/sign-in?error=email_not_verified`，显示人话 |
| 用户在第三方页面点了「取消」 | 第三方回调带 `error=access_denied`，落到同一错误页，显示通用失败文案 |
| 已登录状态下又点第三方登录 | 沿用 Better Auth 既有行为，本次不额外处理 |

## 失败与限制

- **第三方登录路径没有人机验证。** Turnstile 目前只挂在 `/sign-up/email`、`/sign-in/email`、`/request-password-reset` 三个端点上，且 Better Auth 的人机验证插件不支持 OAuth 端点。OAuth 本身有反机器人特性，按行业惯例接受——这是**有意保留的缺口**，不是遗漏。
- **第三方注册的用户拿不到 `marketingOptInRequested`**，落库为默认 `false`；`preferredLocale` 落库为默认 `en`、`localeSource` 为 `fallback`。中文用户首次可能收到英文邮件，可在账号设置里改。本次不通过 `mapProfileToUser` 补写——回调回来的请求上下文里没有可靠的语言来源，硬塞容易写错。列为已知限制。
- **X（Twitter）不支持**，理由见「范围」。

## 验证

1. `npm run typecheck`、`npm run lint`、`npm test`。
2. 自动化断言（不依赖真实第三方）：
   - `getCapabilities()` 在开关关闭或缺凭据时 `googleOAuth` / `githubOAuth` 的 `configured` 为 false；
   - 两个页面在 `configured` 为 false 时不渲染第三方区块；
   - `login.tsx` 源码包含 `SocialSignIn` 与分隔线，且分隔线受 provider 数量控制；
   - 错误码映射表覆盖上表每一行，未知码回落到通用文案；
   - 新词条在中英两侧都存在，英文不含 CJK。
3. **真实浏览器手工验证**（按项目规矩，这是主验证，不是补充）：
   - 在 Google Cloud 与 GitHub 各建好应用，凭据填入 `.env`，两个开关置 `true`；
   - 启动本地服务，用 Chrome 打开 `http://localhost:3000/zh-CN/sign-in`；
   - **真点**「用 Google 登录」，走完 Google 的真实登录与授权页，确认落到 `/zh-CN/dashboard` 且处于登录态；
   - 退出后再**真点**「用 GitHub 登录」，同样走完，确认落到 `/zh-CN/dashboard`；
   - 打开注册页，确认两个按钮同样存在且可用；
   - 制造一次失败（Google 后台临时改错回调地址，或用邮箱未验证的 GitHub 账号），确认落到错误页并显示人话文案，而不是原始报错；
   - 把 `FEATURE_GOOGLE_OAUTH` 改回 `false` 重启，确认按钮消失、页面退化正常。
