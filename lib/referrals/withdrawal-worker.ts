import 'server-only';
import { createHmac, randomUUID } from 'node:crypto';
import { requireCapability } from '@/lib/config';
import { client } from '@/lib/db/drizzle';
import { decryptWithdrawalAccount, type WithdrawalAccountContext } from './withdrawal-crypto';
import { logObservation } from '@/lib/observability/logger';

type Job = {
  id: string; user_id: string; amount_decimal: string; currency: 'USDT';
  method: 'BINANCE_UID' | 'BLOCKCHAIN'; blockchain: 'BSC' | 'ARBITRUM' | null;
  account_ciphertext: string | null; account_key_version: string; attempt_count: number;
};
type Result = 'submitted' | 'uncertain' | 'rejected' | 'manual_review';
export type WithdrawalDispatchReport = {
  claimed: number; submitted: number; uncertain: number;
  rejected: number; manual_review: number;
};

async function claim(owner: string, requestedId?: string): Promise<Job | null> {
  return client.begin(async (tx) => {
    // A row without a ciphertext is a terminal payout whose payload the
    // retention scrub already removed. It must never be claimed again, even if
    // its status or lease were somehow reset, because there is nothing left to
    // decrypt and a retry would only burn an attempt.
    const [row] = await tx<Job[]>`
      SELECT * FROM referral_withdrawal_intents
      WHERE (${requestedId || null}::text IS NULL OR id = ${requestedId || null})
        AND account_ciphertext IS NOT NULL
        AND ((status IN ('pending', 'uncertain') AND available_at <= now()) OR
             (status = 'sending' AND lease_expires_at <= now()))
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED LIMIT 1
    `;
    if (!row) return null;
    await tx`
      UPDATE referral_withdrawal_intents
      SET status = 'sending', lease_owner = ${owner},
          lease_expires_at = now() + interval '30 seconds',
          attempt_count = attempt_count + 1, updated_at = now()
      WHERE id = ${row.id}
    `;
    return row;
  });
}

async function settle(job: Job, owner: string, status: Result, code?: string,
  centerId?: string, retryAfter?: string | null) {
  const attempt = job.attempt_count + 1;
  const seconds = Number(retryAfter);
  const retryMs = Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, 3_600_000)
    : Math.min(5_000 * 2 ** Math.min(attempt - 1, 8), 3_600_000)
      + Math.floor(Math.random() * 2_000);
  const nextAt = new Date(Date.now() + retryMs).toISOString();
  const settled = await client`
    UPDATE referral_withdrawal_intents
    SET status = ${status}::referral_withdrawal_status,
        center_withdrawal_id = COALESCE(${centerId || null}, center_withdrawal_id),
        last_error_code = ${code || null},
        available_at = ${nextAt}::timestamptz,
        lease_owner = NULL, lease_expires_at = NULL,
        submitted_at = CASE WHEN ${status} = 'submitted' THEN now() ELSE submitted_at END,
        updated_at = now()
    WHERE id = ${job.id} AND status = 'sending' AND lease_owner = ${owner}
    RETURNING id
  `;
  // Only the holder of the lease may report the outcome, and it reports it
  // exactly once: without this guard a lost lease would duplicate the record.
  if (settled.length) {
    logObservation({
      event: 'withdrawal.dispatch',
      module: 'referrals',
      level: status === 'submitted' ? 'info' : 'warn',
      status,
      businessId: job.id,
      taskId: job.id,
      retryCount: attempt,
      maskedErrorCode: code,
    });
  }
}

function endpoint(path: string) {
  const url = new URL(path, process.env.PAYMENT_CENTER_BASE_URL);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Insecure Payment Center endpoint.');
  }
  return url;
}

async function processJob(job: Job, owner: string, send: typeof fetch): Promise<Result> {
  const context: WithdrawalAccountContext = {
    id: job.id, userId: job.user_id, amount: job.amount_decimal,
    currency: job.currency, method: job.method, blockchain: job.blockchain,
  };
  let account: string;
  if (!job.account_ciphertext) {
    // The retention scrub removed the payout account of a terminal payout, so
    // the dispatch stops for a human instead of failing as a broken ciphertext.
    await settle(job, owner, 'manual_review', 'PAYLOAD_SCRUBBED');
    return 'manual_review';
  }
  try {
    account = decryptWithdrawalAccount(
      context, job.account_key_version, job.account_ciphertext,
    );
  } catch {
    await settle(job, owner, 'manual_review', 'ACCOUNT_DECRYPT_FAILED');
    return 'manual_review';
  }
  try {
    const summary = await send(endpoint(
      `/api/referral-center/users/${encodeURIComponent(job.user_id)}/summary?currency=USDT`,
    ), {
      headers: { 'X-API-Key': process.env.PAYMENT_CENTER_REFERRAL_API_KEY! },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000),
    });
    if (!summary.ok) throw new Error('Remote user check unavailable.');
    const summaryBody = await summary.json() as {
      status?: string; data?: { exists?: boolean; user?: {
        id?: string; website_id?: string; external_user_id?: string;
      } };
    };
    const remoteUser = summaryBody.data?.user;
    if (summaryBody.status !== 'success' || !summaryBody.data?.exists || !remoteUser ||
        remoteUser.website_id !== process.env.PAYMENT_CENTER_WEBSITE_ID ||
        remoteUser.external_user_id !== job.user_id || !remoteUser.id) {
      await settle(job, owner, 'manual_review', 'USER_BINDING_MISMATCH');
      return 'manual_review';
    }

    const path = '/api/referral-center/withdrawals';
    const body = JSON.stringify({
      external_user_id: job.user_id,
      external_withdrawal_id: job.id,
      amount: job.amount_decimal,
      currency: job.currency,
      method: job.method,
      payout_account: account,
      ...(job.blockchain ? { blockchain: job.blockchain } : {}),
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID().replaceAll('-', '');
    // The centre's verifier separates parts with a LITERAL backslash-n pair
    // (`\\n` in its Python source), not a newline; a real newline fails the
    // HMAC. See the same note in lib/referrals/reversal.ts.
    const signature = createHmac('sha256', process.env.REFERRAL_WITHDRAWAL_REQUEST_SECRET!)
      .update(['POST', path, body, timestamp, nonce].join('\\n')).digest('hex');
    const response = await send(endpoint(path), {
      method: 'POST', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(8_000),
      headers: {
        'X-API-Key': process.env.PAYMENT_CENTER_WITHDRAWAL_API_KEY!,
        'X-Withdrawal-Timestamp': timestamp,
        'X-Withdrawal-Nonce': nonce,
        'X-Withdrawal-Signature': signature,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const errorBody = await response.json().catch(() => ({})) as { message?: string };
        const message = errorBody.message || '';
        const code = message.includes('可用余额不足') ? 'INSUFFICIENT_BALANCE'
          : message.includes('不得低于') ? 'BELOW_MINIMUM'
          : message.includes('Maintenance Mode') ? 'MAINTENANCE'
          : message.includes('已用于不同提现申请') ? 'IDEMPOTENCY_CONFLICT'
          : 'PROVIDER_REJECTED';
        await settle(job, owner, 'rejected', code);
        return 'rejected';
      }
      throw new Error(`Remote withdrawal HTTP ${response.status}`);
    }
    const result = await response.json() as { status?: string; data?: {
      success?: boolean; withdrawal?: Record<string, unknown>;
    } };
    const withdrawal = result.data?.withdrawal;
    if (result.status !== 'success' || result.data?.success !== true ||
        withdrawal?.website_id !== process.env.PAYMENT_CENTER_WEBSITE_ID ||
        withdrawal?.referral_user_id !== remoteUser.id ||
        withdrawal?.external_withdrawal_id !== job.id ||
        withdrawal?.amount_decimal !== job.amount_decimal ||
        withdrawal?.currency !== job.currency ||
        withdrawal?.method !== (job.blockchain ? `BLOCKCHAIN_${job.blockchain}` : job.method) ||
        withdrawal?.payout_account !== account || typeof withdrawal.id !== 'string') {
      await settle(job, owner, 'manual_review', 'RECEIPT_MISMATCH');
      return 'manual_review';
    }
    await settle(job, owner, 'submitted', undefined, withdrawal.id);
    return 'submitted';
  } catch {
    if (job.attempt_count + 1 >= 8) {
      await settle(job, owner, 'manual_review', 'RESULT_UNCONFIRMED');
      return 'manual_review';
    }
    await settle(job, owner, 'uncertain', 'RESULT_UNCONFIRMED');
    return 'uncertain';
  }
}

export async function runWithdrawalDispatch(options: {
  requestedId?: string; maxJobs?: number; maxMillis?: number; send?: typeof fetch;
} = {}): Promise<WithdrawalDispatchReport> {
  requireCapability('referralWithdrawals');
  const owner = randomUUID();
  const deadline = Date.now() + (options.maxMillis ?? 20_000);
  const report: WithdrawalDispatchReport = {
    claimed: 0, submitted: 0, uncertain: 0, rejected: 0, manual_review: 0,
  };
  for (let i = 0; i < (options.maxJobs ?? 20) && Date.now() < deadline; i++) {
    const job = await claim(owner, options.requestedId);
    if (!job) break;
    report.claimed++;
    report[await processJob(job, owner, options.send ?? fetch)]++;
    if (options.requestedId) break;
  }
  logObservation({
    event: 'withdrawal.dispatch',
    module: 'referrals',
    code: 'OK',
    status: 'processed',
    count: report.submitted,
    retryCount: report.uncertain + report.rejected + report.manual_review,
  });
  return report;
}
