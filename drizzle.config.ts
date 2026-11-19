import type { Config } from 'drizzle-kit';

export default {
  schema: [
    './lib/db/auth-schema.ts',
    './lib/db/integration-schema.ts',
    './lib/db/activity-schema.ts',
    './lib/db/book-schema.ts',
  ],
  out: './lib/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config;
