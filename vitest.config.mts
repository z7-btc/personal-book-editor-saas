import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The server modules in this repository start with `import 'server-only'`.
// Node resolves that package through its `react-server` export condition to an
// empty module; without the condition it throws the "Client Component" error.
// Vitest therefore has to run every test with the same condition Next.js uses.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
    conditions: ['react-server', 'node', 'import', 'default'],
  },
  ssr: {
    resolve: {
      conditions: ['react-server', 'node', 'import', 'default'],
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    globals: false,
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/support/setup.ts'],
    // Each test file runs against its own database cloned from the migrated
    // template (see tests/support/database.ts), so files can run in parallel.
    // The template is migrated once by the global setup, and every clone costs
    // one file copy instead of a migration replay.
    fileParallelism: true,
    pool: 'forks',
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['lib/**/*.ts', 'app/api/**/*.ts'],
      exclude: ['lib/db/migrations/**'],
    },
  },
});
