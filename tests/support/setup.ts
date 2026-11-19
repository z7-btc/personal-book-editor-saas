import { afterAll } from 'vitest';
import { config } from 'dotenv';
import { dropIsolatedDatabase, provisionTestDatabase } from './database';

/**
 * Vitest `setupFiles` run after a test file's imports are collected but before
 * any of them is evaluated, so this is the earliest moment at which the private
 * database URL can be exported for `lib/db/drizzle.ts` to read.
 *
 * Ordering matters: dotenv loads the same `.env` the smoke scripts use while
 * letting an explicitly exported variable win, and it never overrides the
 * DATABASE_URL chosen below.
 */
config({ override: false, quiet: true });

// Each test file executes against its own empty database cloned from the
// migrated template, and drops it again in its own teardown. Nothing in the
// suite writes to the development database named by `.env`.
process.env.DATABASE_URL = provisionTestDatabase(`pool_${process.env.VITEST_POOL_ID ?? '0'}`);

afterAll(() => {
  dropIsolatedDatabase();
});
