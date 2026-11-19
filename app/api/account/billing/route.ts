import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { BillingAccessError } from '@/lib/billing/account';
import { getBillingHistory, BillingHistoryCursorError } from '@/lib/billing/history';
import { billingHistoryQuerySchema } from '@/lib/billing/history-contract';

export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return Response.json({ error: 'unauthorized' }, { status: 401, headers: privateHeaders });
    const search = new URL(request.url).searchParams;
    // Reject duplicates and identity selectors rather than using the last value.
    if ([...search.keys()].some((key) => search.getAll(key).length !== 1)) {
      return Response.json({ error: 'invalid_query' }, { status: 422, headers: privateHeaders });
    }
    const query = billingHistoryQuerySchema.safeParse(Object.fromEntries(search));
    if (!query.success) return Response.json({ error: 'invalid_query' }, { status: 422, headers: privateHeaders });
    const data = await getBillingHistory(session.user.id, query.data);
    return Response.json({ data }, { headers: privateHeaders });
  } catch (error) {
    const status = error instanceof BillingAccessError ? 403 : error instanceof BillingHistoryCursorError ? 422 : 503;
    const code = status === 403 ? 'forbidden' : status === 422 ? 'invalid_cursor' : 'billing_unavailable';
    return Response.json({ error: code }, { status, headers: privateHeaders });
  }
}
