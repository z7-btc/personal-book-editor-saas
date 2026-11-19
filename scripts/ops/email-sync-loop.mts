import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';

// Load the database only after dotenv has populated DATABASE_URL.
const { client } = await import('../../lib/db/drizzle');
const { requireCapability } = await import('../../lib/config');
const { runEmailContactSync } = await import('../../lib/email-center/worker');
const { runEmailContactReconcile } = await import('../../lib/email-center/reconcile');

requireCapability('emailCenter');

const shutdown = new AbortController();
process.once('SIGINT', () => shutdown.abort());
process.once('SIGTERM', () => shutdown.abort());

async function pause(ms: number) {
  try {
    await delay(ms, undefined, { signal: shutdown.signal });
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  }
}

try {
  let reconcileAt = 0;
  while (!shutdown.signal.aborted) {
    try {
      const report = await runEmailContactSync({ maxJobs: 25, maxMillis: 20_000 });
      if (report.claimed || report.deadLetter) console.log(JSON.stringify(report));
      // Drain a backlog immediately; wait briefly only after the queue is empty.
      if (!shutdown.signal.aborted && Date.now() >= reconcileAt) {
        const reconciliation = await runEmailContactReconcile({ maxJobs: 10, maxMillis: 5_000 });
        if (reconciliation.checked) console.log(JSON.stringify({ reconciliation }));
        reconcileAt = Date.now() + 60_000;
      }
      if (!report.claimed) await pause(5_000);
    } catch {
      console.error(JSON.stringify({ error: 'email_runner_unavailable' }));
      await pause(30_000);
    }
  }
} finally {
  await client.end({ timeout: 5 });
}
