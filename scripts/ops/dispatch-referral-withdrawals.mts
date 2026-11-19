import 'dotenv/config';

async function main() {
  const module = await import('../../lib/referrals/withdrawal-worker');
  const worker = (module as { default?: typeof module }).default ?? module;
  const report = await worker.runWithdrawalDispatch({ maxJobs: 50, maxMillis: 30_000 });
  console.log(JSON.stringify(report));
}

main().finally(async () => {
  const module = await import('../../lib/db/drizzle');
  const db = (module as { default?: typeof module }).default ?? module;
  await db.client.end({ timeout: 5 });
});
