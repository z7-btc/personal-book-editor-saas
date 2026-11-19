import { createHash, timingSafeEqual } from 'node:crypto';

export const cronHeaders = { 'Cache-Control': 'no-store' };

export function cronFailure(request: Request): Response | null {
  if (process.env.RECOVERY_RUNNER_MODE !== 'cron') {
    return Response.json({ error: 'runner_disabled' }, { status: 503, headers: cronHeaders });
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) {
    return Response.json({ error: 'runner_unconfigured' }, { status: 503, headers: cronHeaders });
  }
  const bearer = request.headers.get('authorization');
  if (!bearer?.startsWith('Bearer ') || bearer.length > 1024) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: cronHeaders });
  }
  const expectedHash = createHash('sha256').update(secret).digest();
  const suppliedHash = createHash('sha256').update(bearer.slice(7)).digest();
  if (!timingSafeEqual(expectedHash, suppliedHash)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: cronHeaders });
  }
  return null;
}
