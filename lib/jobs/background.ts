import 'server-only';
import { reconcileCommissionIntents } from '@/lib/billing/submit';
import { getCapabilities } from '@/lib/config';
import { verifyEmailCenterConnection } from '@/lib/email-center/heartbeat';
import { runEmailContactReconcile } from '@/lib/email-center/reconcile';
import { runEmailContactSync } from '@/lib/email-center/worker';
import { runPaymentInbox } from '@/lib/payment-center/inbox-worker';
import { runReferralUserSync } from '@/lib/referrals/worker';
import { runWithdrawalDispatch } from '@/lib/referrals/withdrawal-worker';
import { refreshDueSubscriptions } from '@/lib/subscription/service';
import { mirrorBookJobs, reconcileBookJobsOnBoot } from '@/lib/book-store/job-runner';
import { reconcileAllUsers } from '@/lib/book-store/reconcile';
import { logObservation, maskErrorCode } from '@/lib/observability/logger';

/**
 * Drains the background queues inside the web process, so starting the app is
 * all it takes for referral sync, the payment inbox, email delivery and
 * withdrawal dispatch to make progress. The queues are durable PostgreSQL
 * tables; without a runner, a fresh signup sits in "syncing" and a settled
 * payment never reaches the Referral Center until someone starts one.
 *
 * This calls the workers directly rather than going through
 * `/api/internal/*`. Those endpoints answer only when `RECOVERY_RUNNER_MODE`
 * is `cron`, which the standalone `npm run worker` uses; an in-process runner
 * has no request to authenticate and no reason to depend on that switch.
 *
 * Running it in more than one place is safe: every queue claim is a row lock
 * with a lease, so a second runner (or the standalone worker) can only ever
 * take work that is genuinely free. The queues this drains are all
 * network-bound — waiting on the Payment Center or the Email Center — so the
 * loop costs the web process very little; there is no switch to turn it off,
 * because nothing here is worth complicating a deployment over.
 */

type JobEvent = 'email.sync' | 'email.reconcile' | 'email.verify' | 'payment.reconcile'
  | 'referral.sync' | 'withdrawal.dispatch' | 'book.jobs';

type Job = {
  kind: string;
  event: JobEvent;
  intervalMs: number;
  /**
   * Runs only when its integration is configured: a disabled capability is a
   * deployment choice, and reporting it as a failure on every tick would bury
   * the failures that matter. The worker's own `requireCapability` stays as
   * the backstop.
   */
  enabled: () => boolean;
  run: () => Promise<unknown>;
};

export const BACKGROUND_JOBS: Job[] = [
  {
    kind: 'email-sync',
    event: 'email.sync',
    intervalMs: 10_000,
    enabled: () => getCapabilities().emailCenter.configured,
    run: () => runEmailContactSync({ maxJobs: 25, maxMillis: 20_000 }),
  },
  {
    kind: 'email-reconcile',
    event: 'email.reconcile',
    intervalMs: 60_000,
    enabled: () => getCapabilities().emailCenter.configured,
    run: () => runEmailContactReconcile({ maxJobs: 25, maxMillis: 20_000 }),
  },
  {
    // 保活心跳。上面那两个 job 只在**有活儿**的时候才发 HTTP（队列空就直接返回），
    // 所以它们**不构成心跳**：一个没人注册的站，同步队列永远是空的，邮件中心那边
    // `lastApiUsedAt` 一直不动，15 分钟后牌子变红——明明什么都没坏。
    // 这一条不看队列，到点就报到一次，把「还连得上」这件事说清楚。
    //
    // 5 分钟是邮件中心 README 给的数（硬上限 10 分钟），对 15 分钟的窗口留 3 倍余量：
    // 中间漏掉一两次也不会闪红。**别往大调**——调到 15 分钟以上，徽章会重新变红，
    // 而且这次没有任何报错。
    kind: 'email-verify',
    event: 'email.verify',
    intervalMs: 5 * 60_000,
    enabled: () => getCapabilities().emailCenter.configured,
    run: () => verifyEmailCenterConnection(),
  },
  {
    kind: 'payment-reconcile',
    event: 'payment.reconcile',
    intervalMs: 30_000,
    enabled: () => getCapabilities().paymentCenter.configured,
    run: async () => {
      const commission = await reconcileCommissionIntents(2);
      const inbox = await runPaymentInbox({ maxJobs: 10, maxMillis: 15_000 });
      const refreshedSubscriptions = await refreshDueSubscriptions(50);
      return { commission, inbox, refreshedSubscriptions };
    },
  },
  {
    kind: 'referral-sync',
    event: 'referral.sync',
    intervalMs: 15_000,
    enabled: () => getCapabilities().referrals.configured,
    run: () => runReferralUserSync({ maxJobs: 25, maxMillis: 20_000 }),
  },
  {
    kind: 'withdrawal-dispatch',
    event: 'withdrawal.dispatch',
    intervalMs: 30_000,
    enabled: () => getCapabilities().referralWithdrawals.configured,
    run: () => runWithdrawalDispatch({ maxJobs: 20, maxMillis: 20_000 }),
  },
  {
    // 书籍任务跑在本进程内存里（引擎的 JobManager），这里只做两件事：
    // 把进度写进数据库、任务结束时同步书库卡片。任务本身不依赖这个循环。
    kind: 'book-jobs',
    event: 'book.jobs',
    intervalMs: 5_000,
    enabled: () => true,
    run: () => mirrorBookJobs(),
  },
];

const TICK_MS = 5_000;
const STARTED = Symbol.for('saas.background-jobs.started');

/**
 * Starts the loop once per process. Dev-mode reloads re-enter this module in a
 * fresh process, which is why the guard lives on `globalThis`: it survives a
 * module re-evaluation but not a real restart, which is exactly the boundary
 * the guard should have.
 */
export function startBackgroundJobs() {
  const scope = globalThis as typeof globalThis & { [STARTED]?: boolean };
  if (scope[STARTED]) return;
  scope[STARTED] = true;

  // 上次进程留下的书籍任务收尾：内存任务已不存在，但数据库行可能还是
  // running、磁盘上的章节可能还停在 processing。启动时统一收拾一次。
  void (async () => {
    try {
      await reconcileBookJobsOnBoot();
      await reconcileAllUsers();
    } catch (error) {
      logObservation({
        event: 'book.jobs',
        module: 'book',
        level: 'warn',
        status: 'unavailable',
        maskedErrorCode: maskErrorCode(error, 'BOOK_RECONCILE_FAILED'),
      });
    }
  })();

  const lastRun = new Map<string, number>();
  let busy = false;

  const tick = async () => {
    const now = Date.now();
    for (const job of BACKGROUND_JOBS) {
      if (now - (lastRun.get(job.kind) ?? 0) < job.intervalMs) continue;
      lastRun.set(job.kind, now);
      if (!job.enabled()) continue;
      try {
        await job.run();
      } catch (error) {
        // An unconfigured capability or an unreachable provider is expected
        // here; the next tick tries again. Never let one job stop the loop.
        logObservation({
          event: job.event,
          module: 'jobs',
          level: 'warn',
          status: 'unavailable',
          maskedErrorCode: maskErrorCode(error, 'JOB_UNAVAILABLE'),
        });
      }
    }
  };

  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void tick().finally(() => { busy = false; });
  }, TICK_MS);
  // Never hold the process open on the runner's account.
  timer.unref?.();
}
