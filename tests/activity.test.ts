import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupFixtures, createUserFixture, getClient, scopedId, uniqueSuffix } from './support/fixtures';

// The activity log is the only place a user can see what happened to their own
// account, so these tests pin the two properties the plan calls out: a cursor
// is bound to its viewer, and writing the same business operation twice must
// not create a second row.
type CursorModule = typeof import('@/lib/activity/cursor');
type RecordModule = typeof import('@/lib/activity/record');
type EventsModule = typeof import('@/lib/activity/events');

let cursor: CursorModule;
let record: RecordModule;
let events: EventsModule;

const suffix = uniqueSuffix();
const userId = scopedId('activity-user', suffix);
const otherUserId = scopedId('activity-other', suffix);
const activityIds: string[] = [];

beforeAll(async () => {
  cursor = await import('@/lib/activity/cursor');
  record = await import('@/lib/activity/record');
  events = await import('@/lib/activity/events');
  await createUserFixture({ suffix: `${suffix}-owner`, id: userId });
  await createUserFixture({ suffix: `${suffix}-other`, id: otherUserId });
});

afterAll(async () => {
  await cleanupFixtures({ userIds: [userId, otherUserId], activityIds });
});

describe('activity cursor contract', () => {
  it('round-trips an opaque cursor for its own viewer', () => {
    const encoded = cursor.encodeActivityCursor(userId, '900', '1000');
    // The cursor travels through a URL and the query string, so it must not
    // reveal the viewer or the raw row identifiers.
    expect(encoded).not.toContain(userId);
    expect(encoded).not.toContain('900');
    expect(cursor.decodeActivityCursor(userId, encoded)).toEqual({ v: 1, before: '900', ceiling: '1000' });
  });

  it('refuses a cursor minted for another viewer', () => {
    const encoded = cursor.encodeActivityCursor(userId, '900', '1000');
    expect(() => cursor.decodeActivityCursor(otherUserId, encoded)).toThrow(cursor.InvalidActivityCursor);
  });

  it('refuses a tampered signature instead of paginating from an attacker-chosen row', () => {
    const encoded = cursor.encodeActivityCursor(userId, '900', '1000');
    expect(() => cursor.decodeActivityCursor(userId, `${encoded.slice(0, -2)}xy`)).toThrow(cursor.InvalidActivityCursor);
  });

  it('refuses malformed, oversized and inverted cursors', () => {
    for (const value of ['', 'not-a-cursor', 'a.b.c', 'x'.repeat(300)]) {
      expect(() => cursor.decodeActivityCursor(userId, value)).toThrow(cursor.InvalidActivityCursor);
    }
    // `before` may never sit above `ceiling`, otherwise the window is empty.
    expect(() => cursor.encodeActivityCursor(userId, '1000', '900')).toThrow(cursor.InvalidActivityCursor);
    expect(() => cursor.encodeActivityCursor(userId, '0', '900')).toThrow(cursor.InvalidActivityCursor);
  });
});

describe('activity recording', () => {
  it('records a whitelisted event exactly once per operation key', async () => {
    const client = await getClient();
    const operationKey = `vitest-op-${uniqueSuffix()}`;
    const input = {
      userId,
      type: 'account_profile_updated' as const,
      source: 'system' as const,
      operationKey,
    };

    const first = await record.recordActivity(input);
    expect(first.created).toBe(true);
    expect(first.id).not.toBeNull();
    if (first.id) activityIds.push(first.id);

    // The same business operation must be idempotent: a retried hook or a
    // replayed event may not append a second history row.
    const second = await record.recordActivity(input);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    const rows = await client<{ count: string }[]>`
      SELECT count(*)::text AS count FROM account_activity
      WHERE user_id = ${userId} AND operation_key = ${operationKey}
    `;
    expect(rows[0].count).toBe('1');
  });

  it('rejects an unknown event type instead of widening the whitelist', async () => {
    await expect(record.recordActivity({
      userId,
      type: 'definitely_not_an_event' as never,
      source: 'system',
      operationKey: `vitest-op-${uniqueSuffix()}`,
    })).rejects.toThrow();
  });

  it('requires the entity reference to be complete', async () => {
    // A half-specified reference would let the feed leak a dangling id.
    await expect(record.recordActivity({
      userId,
      type: 'account_profile_updated',
      source: 'system',
      operationKey: `vitest-op-${uniqueSuffix()}`,
      entityId: 'orphan',
    })).rejects.toThrow();
  });

  it('keeps the recorded payload free of free-form metadata', async () => {
    const client = await getClient();
    const operationKey = `vitest-op-${uniqueSuffix()}`;
    const created = await record.recordActivity({
      userId,
      type: 'security_session_created',
      source: 'auth',
      operationKey,
      entityType: 'session',
      entityId: scopedId('session', uniqueSuffix()),
    });
    if (created.id) activityIds.push(created.id);

    const [row] = await client<{ columns: string }[]>`
      SELECT string_agg(column_name, ',' ORDER BY column_name) AS columns
      FROM information_schema.columns WHERE table_name = 'account_activity'
    `;
    // Guard the shape the privacy requirement depends on: there is no
    // metadata/json column that a caller could stuff a raw payload into.
    expect(row.columns).toBe('entity_id,entity_type,event_type,id,occurred_at,operation_key,source,user_id');
  });
});

describe('activity categories', () => {
  it('derives the category from the event type without a stored duplicate', () => {
    expect(events.activityCategory('billing_payment_confirmed')).toBe('billing');
    expect(events.activityCategory('security_password_changed')).toBe('security');
    expect(events.activityCategory('account_created')).toBe('account');
    // Every whitelisted type must map to a real category.
    for (const type of events.activityEventTypes) {
      expect(['account', 'security', 'billing']).toContain(events.activityCategory(type));
    }
  });
});
