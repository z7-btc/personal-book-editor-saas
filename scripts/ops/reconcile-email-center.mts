import 'dotenv/config';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const flags = new Set(['--force', '--retry']);
const values: Record<string, string> = {};
const selected = new Set<string>();
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!['--user-id', '--event-version', ...flags].includes(arg) || selected.has(arg)) {
    throw new Error('Use --user-id ID --event-version N with --force or --retry.');
  }
  selected.add(arg);
  if (!flags.has(arg)) {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing recovery argument.');
    values[arg] = value;
  }
}
const userId = values['--user-id'];
const eventVersion = values['--event-version'] === undefined ? undefined : Number(values['--event-version']);
if (Boolean(userId) !== (eventVersion !== undefined) || (userId && userId.length > 200) ||
    (eventVersion !== undefined && (!Number.isSafeInteger(eventVersion) || eventVersion <= 0)) ||
    ((selected.has('--force') || selected.has('--retry')) && !userId)) {
  throw new Error('Exact recovery requires the original user ID and positive event version.');
}
const { client } = await import('../../lib/db/drizzle');
const { runEmailContactReconcile, requeueEmailContact } = await import('../../lib/email-center/reconcile');
try {
  const options = { userId, eventVersion, force: selected.has('--force') };
  if (selected.has('--retry')) {
    const result = await requeueEmailContact(userId!, eventVersion!);
    const fingerprint = createHash('sha256').update(`${userId}:${eventVersion}`).digest('hex').slice(0, 12);
    console.log(JSON.stringify({ operationFingerprint: fingerprint, ...result }));
    if (result.action === 'not_requeued') process.exitCode = 1;
  } else {
    const report = await runEmailContactReconcile(options);
    console.log(JSON.stringify(report));
    if (report.conflicts || report.unreachable) process.exitCode = 1;
  }
} catch {
  console.error(JSON.stringify({ error: 'email_reconcile_unavailable' }));
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
