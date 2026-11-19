import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// node --conditions=react-server --import tsx scripts/smoke-activity-boundaries.mts
// No database, web service, mail, or saved configuration is changed.
const originalSecret = process.env.BETTER_AUTH_SECRET;
const viewer = randomUUID();
const other = randomUUID();
const observations: unknown[][] = [];
const originalInfo = console.info;
let checks = 0;
try {
  process.env.BETTER_AUTH_SECRET = 'activity-smoke-process-only-signing-key';

  // The lib modules are loaded dynamically, like every other smoke script here:
  // the package has no "type": "module", so a lib module is transpiled to
  // CommonJS and a STATIC named import from it only reaches the names the ESM
  // linker can detect — which is how `InvalidActivityCursor` used to disappear
  // with `SyntaxError: The requested module … does not provide an export named`.
  const { decodeActivityCursor, encodeActivityCursor, InvalidActivityCursor } =
    await import('../../lib/activity/cursor');
  const { activityEventTypes } = await import('../../lib/activity/events');
  const { logObservation, sanitizeObservation } = await import('../../lib/observability/logger');

  const cursor = encodeActivityCursor(viewer, '15', '25');
  assert.deepEqual(decodeActivityCursor(viewer, cursor), { v: 1, before: '15', ceiling: '25' });
  assert.ok(!cursor.includes(viewer));
  const body = JSON.parse(Buffer.from(cursor.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(body).sort(), ['before', 'ceiling', 'v']);
  checks++;

  assert.throws(() => decodeActivityCursor(other, cursor), InvalidActivityCursor);
  const changed = cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A');
  assert.throws(() => decodeActivityCursor(viewer, changed), InvalidActivityCursor);
  for (const invalid of ['', 'x'.repeat(300), 'not-a-cursor', 'abc.def']) {
    assert.throws(() => decodeActivityCursor(viewer, invalid), InvalidActivityCursor);
  }
  checks++;
  for (const [before, ceiling] of [['0', '1'], ['01', '3'], ['4', '3'], ['9223372036854775808', '9223372036854775808']]) {
    assert.throws(() => encodeActivityCursor(viewer, before, ceiling), InvalidActivityCursor);
  }
  const maximum = '9223372036854775807';
  assert.equal(decodeActivityCursor(viewer, encodeActivityCursor(viewer, maximum, maximum)).before, maximum);
  checks++;
  process.env.BETTER_AUTH_SECRET = 'different-process-only-key';
  assert.throws(() => decodeActivityCursor(viewer, cursor), InvalidActivityCursor);
  checks++;

  const privateValues = {
    email: 'synthetic-private@example.test', cookie: 'synthetic-cookie-secret',
    apiKey: 'synthetic-private-api-key', userId: viewer,
    wallet: '0x' + 'c'.repeat(40), rawBody: { token: 'synthetic-bearer-secret' },
    error: new Error('synthetic-connection-secret'),
  };
  const cleaned = sanitizeObservation({ event: 'activity.read', code: 'OK', count: 3,
    durationMs: 4.4, activityId: '123', correlation: 'a'.repeat(64), ...privateValues });
  assert.deepEqual(cleaned, { event: 'activity.read', code: 'OK', count: 3,
    durationMs: 4, activityId: '123', correlation: 'a'.repeat(64) });
  assert.equal(sanitizeObservation({ event: 'user\nsecret', code: 'OK' }), null);
  // An unknown code is dropped as a FIELD, not as a whole line: the value never
  // reaches the output, and the operational record that something happened
  // survives. A line that disappeared entirely would be the worse failure for
  // the troubleshooting the plan requires the logs to support.
  assert.deepEqual(sanitizeObservation({ event: 'activity.read', code: 'API_KEY_SECRET' }),
    { event: 'activity.read' });
  assert.deepEqual(sanitizeObservation({ event: 'activity.read', code: 'OK',
    maskedErrorCode: 'provider said: token 0xdeadbeef is revoked' }), { event: 'activity.read', code: 'OK' });
  assert.deepEqual(sanitizeObservation({ event: 'activity.read', code: 'OK',
    count: Infinity, durationMs: -1, activityId: 'synthetic-cookie-secret', correlation: viewer }),
  { event: 'activity.read', code: 'OK' });
  checks++;

  console.info = (...values: unknown[]) => { observations.push(values); };
  logObservation({ event: 'activity.read', code: 'OK', count: 3, ...privateValues });
  console.info = originalInfo;
  assert.equal(observations.length, 1);
  const logged = JSON.parse(String(observations[0][1])) as Record<string, unknown>;
  assert.deepEqual(Object.keys(logged).sort(), ['code', 'count', 'event', 'timestamp']);
  const encoded = JSON.stringify(logged);
  for (const value of [privateValues.email, privateValues.cookie, privateValues.apiKey,
    viewer, privateValues.wallet, privateValues.rawBody.token, privateValues.error.message]) assert.ok(!encoded.includes(value));
  checks++;

  const zh = JSON.parse(await readFile(new URL('../../messages/activity.zh-CN.json', import.meta.url), 'utf8'));
  const en = JSON.parse(await readFile(new URL('../../messages/activity.en.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(zh.Activity).sort(), Object.keys(en.Activity).sort());
  for (const type of activityEventTypes) {
    assert.ok(zh.Activity.events[type]?.title && zh.Activity.events[type]?.description);
    assert.ok(en.Activity.events[type]?.title && en.Activity.events[type]?.description);
  }
  checks++;
  console.log('[smoke.activity-boundaries]', { checks, scope: 'viewer-bound signed cursors and whitelist log output', passed: true });
} finally {
  console.info = originalInfo;
  if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = originalSecret;
}
