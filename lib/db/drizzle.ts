import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as authSchema from './auth-schema';
import * as integrationSchema from './integration-schema';
import * as activitySchema from './activity-schema';
import * as bookSchema from './book-schema';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

/**
 * 开发模式下把连接池挂在 globalThis 上复用。
 *
 * Next dev 的 HMR 会反复重新求值模块：每重算一次就新建一个 postgres 连接池
 * （默认 10 条连接），旧池不会被回收 —— 半小时就能把 PostgreSQL 的
 * max_connections 吃光（实测 97 条 idle，其他进程连不进来）。
 * 生产环境模块只求值一次，走不到这里。
 */
const globalForDb = globalThis as unknown as {
  __saasPgClient?: ReturnType<typeof postgres>;
};

export const client = globalForDb.__saasPgClient ?? postgres(process.env.DATABASE_URL);
if (process.env.NODE_ENV !== 'production') globalForDb.__saasPgClient = client;

export const db = drizzle(client, {
  schema: { ...authSchema, ...integrationSchema, ...activitySchema, ...bookSchema },
});
