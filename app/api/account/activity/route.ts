import { getAccountActivity } from '@/lib/activity/feed';
import { InvalidActivityCursor } from '@/lib/activity/cursor';
import { logObservation } from '@/lib/observability/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

/**
 * The error body is the flat `{ error: 'code' }` envelope every other route in
 * this project answers with — including the sibling `/api/account/billing`.
 * This route used to nest the code under `error.code`, which made the two
 * private account endpoints disagree about their own contract.
 */
export async function GET(request: Request) {
  const start = Date.now();
  try {
    const url = new URL(request.url);
    const rawLimit = url.searchParams.get('limit');
    if (url.searchParams.getAll('cursor').length > 1 || url.searchParams.getAll('limit').length > 1 ||
        (rawLimit !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit))) {
      return Response.json({ error: 'invalid_request' }, { status: 400, headers: privateHeaders });
    }
    const data = await getAccountActivity(request.headers, {
      cursor: url.searchParams.get('cursor') ?? undefined,
      ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
    });
    if (!data) return Response.json({ error: 'unauthorized' }, { status: 401, headers: privateHeaders });
    logObservation({ event: 'activity.read', code: 'OK', count: data.items.length, durationMs: Date.now() - start });
    return Response.json({ data }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof InvalidActivityCursor) {
      return Response.json({ error: 'invalid_cursor' }, { status: 400, headers: privateHeaders });
    }
    logObservation({ event: 'activity.failure', code: 'DATABASE_ERROR', level: 'error', durationMs: Date.now() - start });
    return Response.json({ error: 'activity_unavailable' }, { status: 503, headers: privateHeaders });
  }
}
