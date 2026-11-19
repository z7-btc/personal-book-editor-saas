/**
 * Next.js calls `register` once when a server instance starts — during
 * `next dev` and `next start`, not during `next build`. Starting the
 * background queues here is what makes `npm run dev` sufficient on its own:
 * referral sync, the payment inbox, email delivery and withdrawal dispatch all
 * move without a second process.
 *
 * The import is dynamic so the Edge runtime never pulls in the Node-only
 * worker graph; `register` runs for both runtimes.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { startBackgroundJobs } = await import('./lib/jobs/background');
  startBackgroundJobs();
}
