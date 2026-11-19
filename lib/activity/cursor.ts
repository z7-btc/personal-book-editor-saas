import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';

export class InvalidActivityCursor extends Error {
  constructor() { super('INVALID_CURSOR'); }
}
type Cursor = { v: 1; before: string; ceiling: string };
const maximumId = 9_223_372_036_854_775_807n;
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= maximumId;
}
function signature(userId: string, body: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('ACTIVITY_UNAVAILABLE');
  return createHmac('sha256', secret).update(`account-activity\0${userId}\0${body}`).digest();
}
export function encodeActivityCursor(userId: string, before: string, ceiling: string): string {
  if (!validId(before) || !validId(ceiling) || BigInt(before) > BigInt(ceiling)) throw new InvalidActivityCursor();
  const body = Buffer.from(JSON.stringify({ v: 1, before, ceiling } satisfies Cursor)).toString('base64url');
  return `${body}.${signature(userId, body).toString('base64url')}`;
}
export function decodeActivityCursor(userId: string, cursor: string): Cursor {
  if (cursor.length > 256 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw new InvalidActivityCursor();
  const [body, supplied] = cursor.split('.');
  const expected = signature(userId, body);
  const received = Buffer.from(supplied, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(expected, received) || received.toString('base64url') !== supplied) throw new InvalidActivityCursor();
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { throw new InvalidActivityCursor(); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new InvalidActivityCursor();
  const value = decoded as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'before,ceiling,v' || value.v !== 1 ||
      !validId(value.before) || !validId(value.ceiling) || BigInt(value.before) > BigInt(value.ceiling)) throw new InvalidActivityCursor();
  return value as Cursor;
}
