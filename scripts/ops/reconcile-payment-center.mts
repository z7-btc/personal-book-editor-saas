import 'dotenv/config';

const { reconcileCommissionIntents } = await import('../../lib/billing/submit');
const commission = await reconcileCommissionIntents();
const { runPaymentInbox } = await import('../../lib/payment-center/inbox-worker');
const report = await runPaymentInbox({ maxJobs: 25, maxMillis: 20_000 });
const { refreshDueSubscriptions } = await import('../../lib/subscription/service');
const refreshedSubscriptions = await refreshDueSubscriptions();
console.log(JSON.stringify({ ...report, commission, refreshedSubscriptions }));
const { client } = await import('../../lib/db/drizzle');
await client.end({ timeout: 5 });
