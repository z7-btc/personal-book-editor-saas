/**
 * Vitest globalSetup. It runs in the main process after the config loads and
 * before any worker starts.
 *
 * The suite only ever writes to private databases cloned from a migrated
 * template, so this hook has two jobs: drop the clones an interrupted run left
 * behind, and migrate the template once. Both have to happen here rather than
 * in a worker: the migration cannot be held inside a PostgreSQL session lock
 * (it runs as its own `drizzle-kit` process), so four workers each migrating it
 * used to collide — and the loser dropped the template while the others were
 * cloning it.
 */
export async function setup(): Promise<void> {
  const { ensureTemplate, reapOrphanedTestDatabases } = await import('./support/database.ts');
  reapOrphanedTestDatabases();
  ensureTemplate();
}

export async function teardown(): Promise<void> {
  const { reapOrphanedTestDatabases } = await import('./support/database.ts');
  reapOrphanedTestDatabases();
}
