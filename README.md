# SaaS Framework

An in-progress multilingual SaaS framework based on the official `nextjs/saas-starter`
commit recorded in [NOTICE.md](NOTICE.md). The interface ships in English, Simplified
Chinese, Japanese, German, Spanish and French; the list lives in `i18n/routing.ts`.

## Product scope

Each user has a personal account and subscription. Invitations are referral links for
commission attribution. There are no team invitations, member management or workspace
switching. Organization/member storage is retained only as an internal personal
billing identity; public organization APIs return 404. Billing routes derive the
account from the signed-in user and ignore the session active-organization field.

## Current development state

The foundation runs on Next.js 16, React 19, Drizzle/PostgreSQL and Better Auth.
Public home, pricing and FAQ pages have separate `/zh-CN` and `/en` routes, language-specific metadata,
canonical and alternate links, truthful structured data, and a sitemap. The root
route selects a language from the locale cookie, browser preference, then the
Chinese default. Sign-in and dashboard pages use `noindex` metadata. The public
header and authentication forms offer light, dark and system themes. The choice
is stored in a first-party `theme` cookie (`lib/theme.ts`), so the server renders
it onto `<html>` and the first paint is already correct; with no stored choice the
`prefers-color-scheme` media query decides, and an explicit light choice still
wins against a dark operating system. Nothing renders a script to apply it —
React 19 never executes a script a component renders, and the `[locale]` layout is
re-created on every language switch.
Sign-in creates a Better Auth session from the email and password alone. Sign-up
runs in two steps: it creates the (still unusable) account and mails a one-time
code, and entering that code is what confirms the mailbox and mints a session —
an abandoned sign-up leaves an address taken but no way in. A recoverable
bootstrap creates one personal workspace. Cloudflare
Turnstile protects registration and sign-in when enabled; public production
requests fail closed if it is not configured. The old JWT/bcrypt login and direct
Stripe API routes have been removed.

Registration and preference changes now create a versioned Email Center contact
outbox entry in the same PostgreSQL transaction as the user change. The contact
worker coalesces old pending versions, uses stable idempotency keys and retries
temporary failures. Email retries now query the original native receipt
before resending. A separate reconciliation runner detects unknown delivery,
binding drift and authoritative unsubscribe without rewriting remote consent.
CLI, protected Cron and the persistent loop share the same leased core; see
[email-reconciliation.md](docs/email-reconciliation.md). The pricing page mounts
the Payment Center's own checkout widget with the website-scoped key once
configured, so the plan, interval and payment-method choices come from the
centre instead of from a local form. Workspace billing accounts and server-side
payment
intents now retain an exact quote and stable order keys. A signed Payment Center
callback is verified, durably recorded and fulfilled on the delivery itself —
the subscription activates without running a command; a worker or
`npm run payment:reconcile` is only the retry backstop for a delivery the app
could not finish inline. A local reconciliation worker re-queries the event
and order, then creates an idempotent, reversible workspace grant for a complete
positive-amount Stripe invoice period. Payment Center has a local workspace
billing-account order binding, migration, account-scoped subscription controls
and versioned invoice-period evidence. Full Stripe invoice refunds now have a
local period-specific reversal path; a final full lost dispute follows the same
path. Manual approval and confirmed blockchain payments now have a local
prepaid-period grant path. A workspace with an unexpired paid period cannot
start another recurring checkout. Partial refunds and unresolved disputes need
manual review. The account owner’s billing page can query and change automatic
renewal only for a verified active Stripe grant. Its local HTTP smoke uses a
mock Payment Center, so live Stripe control is still unverified. Commission
balance spending has a local two-phase path; the full crash/concurrency matrix
and user checkout acceptance remain incomplete. Zero-amount invoice policy is
also incomplete. The checkout widget
is embedded behind the disabled-by-default Payment Center switch. A dedicated
local Email Center application now accepts real registration, locale and consent
updates through the contact outbox. Its optional public-key Widget loads on the
home page and was checked in Chinese, English and mobile browsers. Production
Email Center binding, remaining public/legal pages,
real referral withdrawal acceptance, live payment Inbox delivery and deployment are **still
being developed**. Do not treat a successful build as completed production
payment or email integration.

A dedicated local Payment Center website is bound with a website-scoped
catalog/order key and its own callback signing secret. On 2026-10-04 the whole
chain was exercised against the running Flask Payment Center: the pricing page
read a real catalog (two plans with monthly and yearly prices), a real manual
order was created, it was approved through the same service the Payment Center
admin button calls, the signed callback was delivered (HTTP 202), the Inbox
worker granted the period, and the handshake then reported all three modules
(`payment_pricing`, `referral`, `payment_callback`) as ready.

The pricing surface was then rebuilt around the centre's remote script, the way
the sibling AutoTrading application integrates it. Each plan card hosts one
`window.PaymentCenter.mount` pinned by `productCode`; the widget owns the method,
interval and chain choices and calls back into
`/api/payment-center/checkout`, which creates the server-side intent and the
centre order. On 2026-10-04 a fresh account paid the Starter plan with the Stripe
test card `4242 4242 4242 4242` on the real hosted checkout page and the
subscription was active before the browser returned to `/dashboard`: the
`payment.succeeded` notification and the `subscription.period_paid` delivery were
fulfilled inside the callback itself, with no `npm run payment:reconcile` run.
The four USDT catalogue prices were retired in the same pass, so the widget's
interval list holds only the USD prices and a card payment is never offered a
currency choice. This is local evidence only: real Stripe control with a live
key, on-chain settlement, a human operator clicking in the real queue, real
payouts and a production site binding are still outstanding — see
[external-conditions.md](docs/external-conditions.md).

Referral registration now creates a stable invitation code and a durable sync
job in the same database transaction. A signed, expiring invite cookie lets a
new user claim the first verified inviter; PostgreSQL rejects later attribution
changes. The referral worker sends only the newest user snapshot to Payment
Center and retries temporary failures. A real local HTTP check covered sign-up,
invite redirect, claim replay, network recovery and the remote inviter binding.
The multilingual referral page and session-scoped overview now show Payment Center
balances, currency-filtered ledger entries and recent withdrawals using exact decimal strings,
plus masked invitation history from the local immutable mirror. The same live
check covers the BFF and rendered page; a mock checks eight-decimal precision.
Its disposable users were removed. The local website has a separate
`referral_read`/`referral_write` key and a **0% local test tier**. Production
commission rules and payout acceptance are not complete. The withdrawal form
now creates a durable encrypted intent and sends a signed, idempotent request
through a separately scoped Payment Center key. It requires verified email
ownership and a sign-in within 15 minutes; a leased dispatcher retries uncertain
results with the same external withdrawal ID. Local mock HTTP and browser checks
cover submission, replay, account masking, refresh recovery, and mobile
Chinese/English display. They do not prove real balances or payouts.
`FEATURE_REFERRALS` is on in this local `.env` (bound to the sibling Payment
Center, whose handshake now reports the referral module ready);
`FEATURE_REFERRAL_WITHDRAWALS` remains off.

The separate transactional-mail adapter now sends user-requested email
verification, email-change approval and password-reset links. Reset links expire after one hour, are
single-use, and revoke existing sessions after a password change. A local mock
mail HTTP test covered delivery, callback validation, token replay, old-password
rejection and new-password sign-in; it did not send real email. Production sender setup remains pending.

Account settings now save the display name, email language and marketing
preference through the existing identity system and ordered contact outbox.
Changing the sign-in email requires a confirmed current address, current
password, recent sign-in and confirmation links to both inboxes. Migration
`0017` adds shared authentication rate limits and atomically revokes all sessions
when the canonical email changes. Email Center's existing unsubscribe protection
follows the identity to the new address. See [账户设置与邮箱变更](docs/account-settings.md)
for policy, local verification and production limits. The SaaS has no operations
dashboard or administrator API; integration recovery remains in jobs and logs.

### Verification and operations

The repository now carries its own verification suite instead of relying on the
checks used while it was being written. `npm test` runs 26 Vitest files against a
real PostgreSQL database, each file in its own database cloned from one migrated
template, so a test may use raw SQL and real concurrency without leaking state
into the next file; `tests/global-setup.ts` reaps what a crashed run left behind
and never touches a database that is still connected — ownership is decided by
the process id recorded with each database, because a worker between two
statements holds no connection and must still not be mistaken for a leftover.
`npm run test:e2e` runs
seven Playwright specs against a real local dev server and the development
database, serially, because one shared server has to answer a cookie and redirect
chain; every spec that needs a third party checks its precondition and skips
naming the missing prerequisite. The specs cover the auth, billing, referral and
Email Center boundaries, the browser console, plus the responsive matrix the plan
asks for: the public
pages at 1440×900, 1024×768 and 390×844 in every locale and both themes, asserted
as no horizontal overflow, a working theme switch and no secret, wallet address or
payout account in the served HTML. There are no committed baseline images, so the
matrix is asserted by property rather than by pixel comparison — a baseline
generated on its first run would prove nothing. The console spec is the guard for
a defect that only appeared on a language switch: React 19 reports a script that a
component renders and never executes it, so the theme arrives as a server-rendered
class instead, and the spec fails if any console error other than the unconfigured
Email Center widget's refused connection appears. The accessibility spec runs axe-core
(WCAG 2.0/2.1 A + AA) over the public pages in every locale and over the entry
pages at a mobile viewport, and asserts the scan finds nothing: an allowlist of
accepted violations would be a list of accepted defects. It also pins WCAG 1.4.4
by name — the viewport meta must not carry `maximum-scale` or
`user-scalable=no` — because that is the one requirement a page can lose by
adding a single attribute, and it had been set here until the scan reported it.
`npm run smoke` starts 16 offline suites, while
the 11 live suites that need the Payment Center, the Email Center, a chain or a
real mailbox start only when named with `--live=NAME` — a missing credential is
reported as blocked, never turned into a fabricated pass. An offline suite whose
precondition is absent reports the same way: `referral-sync` needs an idle
referral queue, `email-sync` needs an empty local database, and
`billing-controls` needs no other `next dev` for this project. Such a suite
prints `[smoke:<name>] blocked: <reason>`, exits with code 2, and the runner
lists it under `Blocked smoke suite(s)` without counting it as passed.

The operations commands match the plan's names. `npm run setup` writes a `.env`
with generated secrets and refuses to touch an existing one without `--rotate`;
`npm run generate-secret -- <NAME>` prints one secret for a deployment's
environment store and writes nothing; `npm run db:seed` verifies the schema and
the capability matrix without inserting anything; `npm run maintenance` applies
the retention policy (completed payloads 30 days, failed payloads 90 days, audit
records 365 days; `--dry-run` reports what it would clear); `npm run worker`
dispatches the `CRON_SECRET`-protected internal endpoints; `npm run reconcile`
re-queries unresolved payment and email events. ESLint runs as a flat config
pinned to ESLint 9, the major `eslint-config-next@16` is built against, and
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs these same local
scripts against a throwaway PostgreSQL service: it never deploys and never talks
to a production service.

`lib/subscription/manager.ts` is the server-side extension point for a
subscription change (renew, interval switch, provider switch). It authorises the
workspace owner, serialises on the subscription row and delegates the money to
the Payment Center; a cross-provider switch stays refused until
`SUBSCRIPTION_PROVIDER_SWITCH=allowed` records that the outgoing cancellation
path has been verified. `lib/observability/logger.ts` accepts only the fields an
operator needs — module, business id, task id, status, retry count, masked error
code — and drops the rest, so a log line cannot carry a secret it was handed by
accident.

Everything that cannot be closed locally — a real Stripe account, an on-chain
confirmation, a real payout, a production Email Center binding, deployment and
production smoke — is listed with its reason in
[external-conditions.md](docs/external-conditions.md). That file, not this
section, is the authoritative list of pending external conditions.

## Local setup

Requirements: Node.js 22+, npm, PostgreSQL 17. On this Windows machine,
PostgreSQL 17 is installed at `D:\Program Files\PostgreSQL\17\bin`.

```powershell
npm install
npm run setup
npm run db:local:up
npm run db:migrate
npm run dev
```

`db:local:up` uses the existing PostgreSQL server on `127.0.0.1:5432`. With
local `postgres` administrator access, it creates a dedicated `saas_framework`
role and database if absent, generates the role password, and updates only
`DATABASE_URL` in the ignored `.env` file. It does not modify Payment Center or
Email Center databases. Repeating `setup`, `db:local:up` and `db:migrate` is safe.
The shared PostgreSQL server is not stopped by `npm run db:local:down`.
Alternatively, with Docker installed, `npm run db:up` starts `compose.dev.yml`
with a separate database container on port 54329. That option requires changing
the ignored `.env` database URL to the container credentials and port.

`npm run dev` starts only Next.js. It does not install packages, migrate a
database or start a recovery worker. The local base URL is
`http://localhost:3000`.
Use `npm run worker` for a manual Email Center sync and `npm run reconcile`
for a manual Payment Center reconciliation run.
Use `npm run referral:sync` for a bounded referral user sync only after the
separate referral feature and website-bound key are configured. In cron mode,
`/api/internal/payment-center/referral-sync` uses the same `CRON_SECRET` and
runner authentication as the other recovery endpoints.
When withdrawal submission is enabled after acceptance, schedule
`npm run withdrawal:dispatch` or authenticated
`GET /api/internal/payment-center/withdrawal-dispatch` independently. The form
attempts immediate dispatch, but recovery requires this runner.
`/api/health` is liveness; `/api/ready` checks PostgreSQL and, when enabled,
actively checks the Payment Center catalog key and Email Center application
key, plus the referral site key when enabled. These checks prove only those API surfaces are reachable. They do not
claim that callbacks, orders, or mail delivery are working.

`POST /api/payment-center/webhook` verifies the callback signature and then
fulfils the delivery it just accepted: it claims exactly that event and applies
the complete Stripe invoice period or the verified manual/blockchain/commission
prepaid period before it answers, so a paid card grants access without waiting
for a scheduler. Whatever the inline attempt cannot finish stays `pending` with
its durable row. `npm run payment:reconcile` claims those signed Payment Center
Inbox events with a
short lease, queries the website-scoped event and order APIs, and applies the
same periods as the retry backstop. It retries temporary lookup
failures and sends incomplete or mismatched evidence to manual review. Run it
only after the Payment Center website binding, API key and callback secret are
configured. Each run also refreshes grants that became active or expired as
their service periods cross the current time. Keep checkout disabled in `.env`
for any site whose Payment Center binding and live acceptance checks are not
complete; this local `.env` enables it against the sibling Payment Center, whose
catalog, manual order, signed callback and grant were verified end to end.
Commission checkout has its own disabled-by-default `FEATURE_COMMISSION_BALANCE`
gate. It stores a pending grant before confirming the reserved spend, then waits
for a verified success event to activate access.

After creating a dedicated Email Center application and setting
`EMAIL_CENTER_URL`, `EMAIL_CENTER_API_KEY`, and `FEATURE_EMAIL_CENTER=true`, run
`npm run email:sync` with a scheduler at least every 10 seconds to meet the
normal registration sync target of 30 seconds. Each run has a bounded time
budget. Failed jobs retry with backoff, then enter `dead_letter` for manual
review. The queue stores user IDs and event versions rather than a second copy
of email addresses. The local Email Center migrations and tests now cover
email rebinding and sticky unsubscribe suppression. Apply those migrations and
repeat the cross-service check in staging before enabling email changes for
real users. The current SaaS settings page saves the display name, the email
language and the marketing preference, and can start a sign-in email change that
both the old and the new inbox have to confirm.

For a persistent worker service, run `npm run email:loop`. It checks an empty
queue every five seconds, drains available batches without waiting, and closes
its database connection on shutdown. Deployment examples and scheduler limits
are in `docs/recovery-runners.md`.

For HTTP scheduling, set `RECOVERY_RUNNER_MODE=cron` and a random 32-byte or
longer `CRON_SECRET`. Call `GET` or `POST /api/internal/email-center/sync` with
`Authorization: Bearer <CRON_SECRET>` every 10 seconds or use an equivalent
continuous runner. The endpoint is unavailable in the default `manual` mode.
It runs the same bounded worker as `npm run email:sync` and returns counts only.
Verify the deployed scheduler's actual frequency and normal registration
delivery time before relying on the 30-second target.
The same Bearer secret and `cron` mode protect
`GET` or `POST /api/internal/payment-center/reconcile`; schedule it separately
from the faster Email Center sync. A local manual run remains available through
`npm run reconcile`.

The optional home-page Widget uses `FEATURE_EMAIL_CENTER_WIDGET=true`,
`EMAIL_CENTER_URL` and `NEXT_PUBLIC_EMAIL_CENTER_WIDGET_KEY`. It loads the
remote `/email-center-widget.js` and is removed when leaving the home page. The
page passes its own locale as `data-locale`, so the form follows the language
the visitor picked here rather than the one their browser announces; switching
language remounts the Widget, so the change is visible without a reload. The
public Widget key must belong to the same Email Center application and its
allowed origins must include the website origin. Widget failures do not stop
registration or other pages.

## Configuration

Copying `.env.example` is done by `npm run setup`, which creates three random
local secrets without overwriting an existing `.env`. Keep that file private.
The "Local default" column is what the shipped example contains; this working
copy's `.env` additionally enables `FEATURE_PAYMENT_CENTER`, `FEATURE_REFERRALS`,
`FEATURE_EMAIL_CENTER`, `FEATURE_EMAIL_CENTER_WIDGET` and `FEATURE_TURNSTILE`
(Cloudflare test keys) against the sibling projects — see
[external-conditions.md](docs/external-conditions.md) for what is still
unverified.

| Variable | Local default | Required when | Purpose / source |
| --- | --- | --- | --- |
| `APP_BASE_URL` | `http://localhost:3000` | All environments | Public origin of this app |
| `DATABASE_URL` | Local isolated PostgreSQL | All environments | PostgreSQL connection; `db:local:up` or a hosting provider |
| `BETTER_AUTH_SECRET` | Generated by setup | All environments | Signs authentication state |
| `FEATURE_TURNSTILE` | `false` | Public production auth | Enables human verification |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Empty | Turnstile enabled | Public key of the SaaS widget |
| `TURNSTILE_SECRET_KEY` | Empty | Turnstile enabled | Private Siteverify key; server only |
| `TURNSTILE_ALLOWED_HOSTNAMES` | Empty | Turnstile enabled | Comma-separated hostnames expected from Siteverify |
| `FEATURE_PAYMENT_CENTER` | `false` | Payment integration | Enables server-only Payment Center contract after acceptance |
| `FEATURE_REFERRALS` | `false` | Referral integration | Enables signed invitation claims and referral user sync after acceptance |
| `PAYMENT_CENTER_REFERRAL_API_KEY` | Empty | Referrals enabled | Separate website-bound `referral_read`/`referral_write` key; no `payment_ingest` |
| `FEATURE_REFERRAL_WITHDRAWALS` | `false` | Accepted withdrawal flow | Enables the member form and durable dispatch queue |
| `PAYMENT_CENTER_WITHDRAWAL_API_KEY` | Empty | Withdrawals enabled | Separate website-bound `withdrawal_create` key |
| `REFERRAL_WITHDRAWAL_REQUEST_SECRET` | Empty | Withdrawals enabled | 32+ character HMAC secret shared only with the Payment Center withdrawal endpoint |
| `FEATURE_COMMISSION_BALANCE` | `false` | Commission checkout | Enables the two-phase reserve, prepare, confirm and refund contract after acceptance |
| `FEATURE_EMAIL_CENTER` | `false` | Contact integration | Enables server-only Email Center contact sync after acceptance |
| `FEATURE_TRANSACTIONAL_EMAIL` | `false` | Email ownership and password reset links | Resend adapter; no registration or sign-in code. No team invitation mail |
| `RESEND_API_KEY`, `EMAIL_FROM` | Empty | Transactional email enabled | Server-only Resend key and verified sender |

All optional variables and defaults are in `.env.example`. Enabled integrations
with missing keys are shown as unavailable and reject writes. This app does not
accept a Stripe secret or Stripe webhook secret. Those stay in Payment Center.

For the SaaS website, create a **separate** Cloudflare Turnstile widget from the
Telegram bot widget. Restrict its production hostname and store its Site Key
and Secret Key in the corresponding variables. The widget uses action
`saas_auth`; the server validates Siteverify success, action and hostname.
Official dummy keys work for local tests, but dummy Siteverify responses do not
carry the real action/hostname values needed for the production metadata check.
The app rejects dummy keys when `NODE_ENV=production`.

Turnstile confirms a challenge, not ownership of an email address. Newly
registered users remain `emailVerified=false`. Email ownership confirmation is
needed before sensitive actions, including withdrawal and payout changes.

## Verification

The gate a change has to pass is the one the bootstrap plan names, in this
order, on a migrated database:

```powershell
npm ci
npm run db:up            # or npm run db:local:up
npm run db:migrate
npm run db:seed          # verifies the schema, writes nothing
npm run lint
npm run typecheck
npm test                 # Vitest, one isolated database per test file
npm run build
```

`npm test` provisions one PostgreSQL database per test file by cloning
`saas_framework_test_template`, which is migrated exactly once per run. The
development database named by `DATABASE_URL` is only read for its connection
details and is never written to. The template is created as `TEST_DB_ADMIN_USER`
(default `postgres`, which authenticates without a password over the loopback
interface); set `TEST_DB_PSQL` when `psql` is not in a standard location. A crash
mid-run leaves databases whose names start with `saas_framework_test_`; the next
run reaps the ones nothing is connected to.

```powershell
npm run smoke            # 16 offline suites, no third party needed
npm run smoke -- --list   # what runs, and the 11 live suites with their reason
npm run maintenance -- --dry-run   # retention preview; reads the three RETENTION_DAYS vars
npm run test:e2e         # Playwright, starts npm run dev itself
```

`npm run smoke` runs every offline suite in sequence and reports each live suite
it did not run, naming the missing prerequisite. A live suite starts only when it
is named explicitly, e.g. `npm run smoke -- --live=payment-center-live`; the plan
requires a missing third-party credential to be reported as blocked rather than
turned into a fabricated success. An offline suite that cannot run for a local
reason (busy referral queue, non-empty database, another dev server holding the
project) reports `[smoke:<name>] blocked: <reason>` and exit code 2, and the run
summarises it as `Blocked smoke suite(s)` instead of a pass.

`npm run test:e2e` drives a real local dev server and the development database
(it needs one shared server, so it is serial). Specs whose precondition is a real
third party skip with that prerequisite named. It writes real accounts and
removes them again in `afterAll`. The accessibility spec needs
`@axe-core/playwright`, which is a devDependency: the scan is part of the suite,
not an optional extra, so a violation fails the run the same way a broken
redirect does.

GitHub Actions runs the same local scripts (`npm ci`, `npm run db:migrate`,
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run seed`)
against a `postgres:17` service container. It never deploys and never talks to a
production service. See [docs/external-conditions.md](docs/external-conditions.md)
for what cannot be verified locally and what each item is waiting on.

The individual smokes remain available for a targeted check:

```powershell
npm run smoke:auth
npm run smoke:email-sync
npm run smoke:payment-catalog
npm run smoke:billing-account
npm run smoke:payment-intent
npm run smoke:payment-order-contract
npm run smoke:payment-subscription-contract
npm run smoke:billing-controls
npm run smoke:payment-webhook
npm run smoke:payment-submit
npm run smoke:subscription-grants
npm run smoke:payment-inbox
npm run smoke:prepaid-grants
npm run smoke:payment-center-live
npm run smoke:payment-handshake
npm run smoke:payment-binding:live
npm run smoke:referral-sync
npm run smoke:referral-binding:live
npm run smoke:referral:live
npm run smoke:email-verification:live
npm run smoke:password-reset:live
npm run smoke:account-settings:live
npm run smoke:withdrawal-crypto
npm run smoke:withdrawal-intent
npm run smoke:withdrawal:http
```

The auth smoke uses a temporary local user, checks registration, session,
sign-in and concurrent personal workspace creation, then deletes its test data.
When running a local dev server with official passing Turnstile test keys, set
`SMOKE_TURNSTILE_TOKEN=XXXX.DUMMY.TOKEN.XXXX` before `npm run smoke:auth`.
`npm run smoke:turnstile:deny` checks that a failing Siteverify response creates
no user. These tests do not replace production-widget hostname/action checks.
The email smoke requires an empty local SaaS database and uses a mock Email
Center HTTP response; it checks ordered coalescing, the unverified-email consent
gate, and retry recovery. It does not prove the real service is connected.
The Payment Center catalog, order and intent smokes use mock HTTP responses.
They check site binding, exact prices, workspace authorization and immutable
order matching; they do not charge or create a real Payment Center order. The
subscription-control smoke starts the SaaS website with a mock Payment Center
and an isolated local paid grant; it checks personal ownership, cross-user isolation, original order
binding, repeat updates and uncertain-write recovery. It does not update a
real Stripe subscription.
webhook smoke verifies HMAC, timestamp, replay handling and quarantine against
the local SaaS database. The grant and Inbox smokes use mock Payment Center HTTP
to verify one grant per invoice or manual/blockchain/commission order, retry recovery,
manual review, and reversal of only the original paid period. The optional
`smoke:payment-center-live` test starts Payment Center's isolated test server,
creates a local manual order, a simulated blockchain settlement and a two-phase
commission order. It receives signed callbacks, grants one workspace period per
order, and verifies a commission refund reverses its grant. It resets only Payment Center's `payment_center_test` database
and deletes its temporary SaaS records. It does not charge a real payment method
or charge a real payment method.
With the sibling Email Center running at `http://localhost:3100`, run
`npm run smoke:email-center:live` against empty local test databases. It creates
temporary records and verifies the real authenticated contact API for
registration and a locale change, then removes those records.
With local SaaS and Payment Center services running, `smoke:payment-handshake`
checks HMAC, timestamp, site binding and one-use challenges against SaaS;
`smoke:payment-binding:live` checks the dedicated website catalog over HTTP.
Neither test creates a charge or asserts that the three integration modules
are ready.

## Source and license

See [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE) for upstream provenance and
MIT license terms.
