import 'dotenv/config';

const { client } = await import('../../lib/db/drizzle');
const { runReferralUserSync } = await import('../../lib/referrals/worker');

try {
  const report = await runReferralUserSync();
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Referral sync failed');
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
