import { headers } from 'next/headers';
import { ZodError } from 'zod';
import { auth } from '@/lib/auth';
import { getCapabilities } from '@/lib/config';
import { client } from '@/lib/db/drizzle';
import {
  prepareWithdrawalIntent, WithdrawalConflict, WithdrawalIdentityRequired,
  WithdrawalInvalidInput, WithdrawalRateLimited, WithdrawalRecentAuthRequired,
  WithdrawalUserSyncPending,
  type WithdrawalInput,
} from '@/lib/referrals/withdrawal-intent';
import { runWithdrawalDispatch } from '@/lib/referrals/withdrawal-worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401, headers: privateHeaders });
  const requestKey = new URL(request.url).searchParams.get('requestKey');
  if (!requestKey || !zUuid.test(requestKey)) {
    return Response.json({ error: 'invalid_request' }, { status: 400, headers: privateHeaders });
  }
  const [row] = await client`
    SELECT id, amount_decimal, currency, method, blockchain, account_mask,
           status::text AS status, last_error_code, created_at
    FROM referral_withdrawal_intents
    WHERE user_id = ${session.user.id} AND request_key = ${requestKey}
  `;
  if (!row) return Response.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
  return Response.json({ data: {
    id: row.id, amount: row.amount_decimal, currency: row.currency,
    method: row.method, blockchain: row.blockchain,
    accountMask: row.account_mask, status: row.status,
    errorCode: row.last_error_code, createdAt: row.created_at,
  } }, { headers: privateHeaders });
}

const zUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  if (request.headers.get('origin') !== new URL(
    process.env.APP_BASE_URL || 'http://localhost:3000',
  ).origin) {
    return Response.json({ error: 'invalid_origin' }, { status: 403, headers: privateHeaders });
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401, headers: privateHeaders });
  if (!getCapabilities().referralWithdrawals.configured) {
    return Response.json({ error: 'withdrawals_unavailable' }, { status: 503, headers: privateHeaders });
  }
  if (!request.headers.get('content-type')?.startsWith('application/json') ||
      Number(request.headers.get('content-length') || 0) > 4_096) {
    return Response.json({ error: 'invalid_request' }, { status: 400, headers: privateHeaders });
  }
  try {
    const raw = await request.text();
    if (raw.length > 4_096) {
      return Response.json({ error: 'invalid_request' }, { status: 400, headers: privateHeaders });
    }
    const body = JSON.parse(raw) as WithdrawalInput;
    const prepared = await prepareWithdrawalIntent(
      { id: session.user.id, emailVerified: session.user.emailVerified },
      session.session.createdAt, body,
    );
    if (prepared.intent.status === 'pending' || prepared.intent.status === 'uncertain') {
      try {
        await runWithdrawalDispatch({ requestedId: prepared.intent.id, maxJobs: 1 });
      } catch {
        // The durable row retains its lease and is retried by the recovery runner.
      }
    }
    const [latest] = await client`
      SELECT id, amount_decimal, currency, method, blockchain, account_mask,
             status::text AS status, last_error_code, created_at
      FROM referral_withdrawal_intents
      WHERE id = ${prepared.intent.id} AND user_id = ${session.user.id}
    `;
    if (!latest) throw new Error('Withdrawal intent disappeared.');
    const status = latest.status === 'submitted' ? (prepared.replay ? 200 : 201)
      : latest.status === 'rejected' ? 422 : 202;
    return Response.json({ data: {
      id: latest.id, amount: latest.amount_decimal, currency: latest.currency,
      method: latest.method, blockchain: latest.blockchain,
      accountMask: latest.account_mask, status: latest.status,
      errorCode: latest.last_error_code, createdAt: latest.created_at,
    } }, { status, headers: privateHeaders });
  } catch (error) {
    const status = error instanceof WithdrawalRateLimited ? 429
      : error instanceof WithdrawalIdentityRequired ||
        error instanceof WithdrawalRecentAuthRequired ? 403
      : error instanceof WithdrawalConflict ||
        error instanceof WithdrawalUserSyncPending ? 409
      : error instanceof ZodError || error instanceof WithdrawalInvalidInput ||
        error instanceof SyntaxError ? 400 : 500;
    const code = error instanceof WithdrawalRateLimited ? 'rate_limited'
      : error instanceof WithdrawalIdentityRequired ? 'email_unconfirmed'
      : error instanceof WithdrawalRecentAuthRequired ? 'recent_sign_in_required'
      : error instanceof WithdrawalUserSyncPending ? 'referral_sync_pending'
      : error instanceof WithdrawalConflict ? 'withdrawal_conflict'
      : status === 400 ? 'invalid_request' : 'withdrawal_unavailable';
    return Response.json({ error: code }, { status, headers: privateHeaders });
  }
}
