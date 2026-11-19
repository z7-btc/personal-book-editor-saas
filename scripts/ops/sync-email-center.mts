import 'dotenv/config';

const { client } = await import('../../lib/db/drizzle');
const { runEmailContactSync } = await import('../../lib/email-center/worker');

try {
  const report = await runEmailContactSync();
  console.log(JSON.stringify(report));
  if (report.deadLetter) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Email sync failed');
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
