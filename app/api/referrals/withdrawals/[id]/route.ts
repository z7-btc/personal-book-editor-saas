import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { client } from '@/lib/db/drizzle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: {
  params: Promise<{ id: string }>;
}) {
  const privateHeaders = { 'Cache-Control': 'private, no-store' };
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401, headers: privateHeaders });
  const { id } = await context.params;
  if (!/^wd_[0-9a-f]{32}$/.test(id)) {
    return Response.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
  }
  const [row] = await client`
    SELECT id, amount_decimal, currency, method, blockchain, account_mask,
           status::text AS status, last_error_code, created_at
    FROM referral_withdrawal_intents WHERE id = ${id} AND user_id = ${session.user.id}
  `;
  if (!row) return Response.json({ error: 'not_found' }, { status: 404, headers: privateHeaders });
  return Response.json({ data: {
    id: row.id, amount: row.amount_decimal, currency: row.currency,
    method: row.method, blockchain: row.blockchain,
    accountMask: row.account_mask, status: row.status,
    errorCode: row.last_error_code, createdAt: row.created_at,
  } }, { headers: privateHeaders });
}
