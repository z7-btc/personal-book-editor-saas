# Recovery runners

The queues drain from inside the app server, so `npm run dev` and
`npm run start` are enough on their own: a payment is fulfilled, a signup is
pushed to the Payment Center, and a contact reaches the Email Center without
anyone running a command. The standalone worker stays available for
deployments that would rather run the queues in their own process — whichever
arrangement is chosen, give it the same database, Email Center and Payment
Center settings as the web service, and do not run a second worker merely to
work around a missing integration key.

## Local manual runs

With `RECOVERY_RUNNER_MODE=manual` (the default):

```sh
npm run worker
npm run email:reconcile
npm run reconcile
npm run referral:sync
npm run withdrawal:dispatch
```

The Email Center worker exits after a bounded batch. To keep syncing while
developing, use `npm run email:loop` in a separate terminal. It checks an empty
queue every five seconds and runs again immediately after a nonempty batch.
It also runs a bounded receipt-reconciliation batch once per minute. Stop it
with Ctrl+C. See [email-reconciliation.md](email-reconciliation.md) for the
query contract and recovery of an exact dead-letter operation.

## Docker, Linux, or a Zeabur worker service

Create a worker service from this repository with the same private database
and Email Center variables as the web service. Set its start command to:

```sh
npm run email:loop
```

Keep one replica initially. The outbox uses database leases and row locking,
but extra replicas should be added only after measuring the actual backlog and
sync delay. The Payment Center callback fulfils each delivery it accepts
(`POST /api/payment-center/webhook` claims exactly the event it just received),
so `npm run reconcile` is the retry backstop rather than the normal path; run it
from a separate scheduler for Payment Center anyway, because
that task has a different frequency and must have its own failure alert.

## HTTP scheduler

Set `RECOVERY_RUNNER_MODE=cron` and a random secret of at least 32 bytes on the
web service. A trusted scheduler calls these endpoints with
`Authorization: Bearer <CRON_SECRET>`:

```text
GET /api/internal/email-center/sync
GET /api/internal/email-center/reconcile
GET /api/internal/payment-center/reconcile
GET /api/internal/payment-center/referral-sync
GET /api/internal/payment-center/withdrawal-dispatch
```

Requests without the exact secret are rejected. The email endpoint works on a
bounded batch; the scheduler must invoke it at least every 10 seconds during
normal operation to meet the planned 30-second contact-sync target. Confirm
the actual registration-to-Email-Center delay after deployment. A successful
HTTP response only proves that one batch ran.
Schedule email receipt reconciliation separately, for example once per minute.
It queries due records; it never treats a failed query as permission to resend.
The referral endpoint processes the same leased user outbox as
`npm run referral:sync`; schedule it independently of payment reconciliation.
The withdrawal endpoint processes encrypted, leased intents with the same
external withdrawal ID on retries. Schedule it independently after configuring
the website-scoped `withdrawal_create` key and request-signing secret. Monitor
`uncertain` and `manual_review` intents: a timeout can mean Payment Center
accepted the request even when SaaS did not receive the receipt. Reconcile the
existing request before considering a new one.
This local `.env` enables `FEATURE_REFERRALS` against the sibling Payment Center
(whose handshake now reports the referral module ready). Keep it `false` in any
environment where the website rules and the remaining referral features have not
passed acceptance. A reachable referral API alone does not prove that balances
or withdrawals work, and `FEATURE_REFERRAL_WITHDRAWALS` stays off until real
payouts are accepted.

Vercel Cron uses minute-resolution schedules, so it cannot by itself provide
the 10-second Email Center cadence. Use the persistent worker above or an
independent scheduler that supports a verified 10-second interval. On a Vercel
plan that supports it, this optional `vercel.json` example schedules Payment
Center reconciliation once per minute:

```json
{
  "crons": [
    { "path": "/api/internal/payment-center/reconcile", "schedule": "* * * * *" }
  ]
}
```

Set `CRON_SECRET` in that deployment so Vercel sends the Bearer header. Its
Hobby plan has a lower Cron frequency limit; check the plan before using the
example. The Email Center worker is still required separately.

## Launch check

Register a disposable local or staging user, keep their marketing preference
false until email ownership is confirmed, and measure the time until the
dedicated Email Center application shows the contact. Then stop Email Center,
register another user, restore it, and confirm the queued event catches up.
Check `dead_letter` rows and scheduler failures before enabling the feature
for real users. Payment reconciliation additionally needs a real configured
Payment Center website and signed callback tests; a 200 response from a
scheduler is not payment proof.
