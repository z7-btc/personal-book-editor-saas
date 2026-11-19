/**
 * `npm run maintenance`
 *
 * Runs one retention pass — the scrub the plan requires but does not schedule
 * ("敏感 payload retention scrub 后 worker 不再误取"). The pass is idempotent, so
 * it is safe to run from a scheduler, from a deployment hook, or by hand after
 * an incident.
 *
 * The work itself lives in lib/jobs/maintenance.ts, next to the schema it
 * touches, and the `react-server` condition is what lets a module guarded by
 * `server-only` load outside a request.
 *
 *   npm run maintenance              scrub, then report what was removed
 *   npm run maintenance -- --dry-run count only, change nothing
 *   npm run maintenance -- --json    raw report
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const json = argv.includes('--json');
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node scripts/maintenance.mjs [--dry-run] [--json]');
  process.exit(0);
}

const projectRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

function loadEnvFile() {
  const path = join(projectRoot, '.env');
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

loadEnvFile();
const { runMaintenance } = await import('../../lib/jobs/maintenance.ts');
const { client } = await import('../../lib/db/drizzle.ts');

try {
  const report = await runMaintenance(new Date(), { dryRun });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const { policy } = report;
    console.log(`${report.dryRun ? 'Retention preview' : 'Retention scrub'} complete.`);
    console.log(`policy: completed payload ${policy.completedPayloadDays}d, `
      + `failed payload ${policy.failedPayloadDays}d, audit ${policy.auditDays}d`);
    console.log(`withdrawal payout accounts emptied: ${report.withdrawalAccountsScrubbed}`);
    console.log(`processed payment events pruned:    ${report.completedEventsPruned}`);
    console.log(`failed payment events pruned:       ${report.failedEventsPruned}`);
    console.log(`expired handshake challenges pruned:${report.expiredChallengesPruned}`);
    console.log(`duration: ${report.durationMs}ms`);
    if (report.dryRun) console.log('Nothing was changed. Rerun without --dry-run to apply.');
  }
} finally {
  await client.end({ timeout: 5 });
}
