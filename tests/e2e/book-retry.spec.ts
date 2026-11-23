import 'dotenv/config';
import { expect, test } from '@playwright/test';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import postgres from 'postgres';

/**
 * 回归：一本书里某章失败后，点「重试」必须真的动起来（2026-11-23）。
 *
 * 线上真实故障：
 *  1. 后台镜像循环和路由处理各有一份 JobManager（Next 把 instrumentation
 *     和 route 编成两套 bundle），路由起的任务镜像那边看不见，book_jobs
 *     的行永远停在 running；
 *  2. 下一次点「重试」被 409 挡住，而错误提示渲染在页面顶部、用户在章节
 *     表格处根本看不到 —— 表现就是「点了没反应」。
 *
 * 这个用例把整条链路走一遍：注册 → 配一个假模型 → 上传书 → 把一章标成
 * 失败 → 点重试；然后确认任务真的跑完、book_jobs 落成 done。最后再塞一条
 * 正在运行的任务，确认 409 的提示会滚进视口，不再「静默」。
 */

const baseURL =
  process.env.E2E_BASE_URL ?? process.env.APP_BASE_URL ?? 'http://localhost:3000';
const projectRoot = process.cwd();
const createdEmails: string[] = [];
const createdUserIds: string[] = [];

type MockProcess = ChildProcessByStdio<null, Readable, Readable>;

let mock: MockProcess | null = null;
let mockBaseUrl = '';

test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  mock = spawn(process.execPath, ['tests/e2e/mock-llm-server.mjs', '0'], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as MockProcess;
  mockBaseUrl = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('mock LLM did not start in 15s')), 15_000);
    mock!.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = buffer.match(/ready (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}/v1`);
      }
    });
    mock!.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[mock-llm] ${chunk.toString('utf8')}`);
    });
    mock!.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`mock LLM exited with code ${code}`));
    });
  });
});

test.afterAll(async () => {
  if (mock) {
    mock.kill('SIGTERM');
    mock = null;
  }
  if (createdEmails.length === 0) return;
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    for (const email of createdEmails) {
      const rows = await client<{ id: string }[]>`SELECT id FROM "user" WHERE email = ${email}`;
      for (const row of rows) {
        await client`DELETE FROM organization WHERE id IN (SELECT organization_id FROM member WHERE user_id = ${row.id})`;
        await client`DELETE FROM "user" WHERE id = ${row.id}`;
      }
    }
  } catch (error) {
    console.warn(`[e2e.book-retry] could not remove test rows: ${(error as Error).message}`);
  } finally {
    await client.end({ timeout: 5 });
  }
  for (const userId of createdUserIds) {
    await fs.rm(path.join(projectRoot, 'data', 'users', userId), { recursive: true, force: true });
  }
});

async function userIdFor(email: string): Promise<string> {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    const rows = await client<{ id: string }[]>`SELECT id FROM "user" WHERE email = ${email}`;
    if (!rows.length) throw new Error(`user ${email} not found`);
    return rows[0].id;
  } finally {
    await client.end({ timeout: 5 });
  }
}

test('章节失败后的重试会真的启动任务，409 提示会滚进视口', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8);
  const email = `e2e-retry-${suffix}@example.test`;
  createdEmails.push(email);

  /* ---- 1. 注册一个全新的真实账号 ---- */
  // 注册页要邮箱验证码，而这套开发环境没有接发信服务（FEATURE_TRANSACTIONAL_EMAIL
  // 为 false），点「发送验证码」只会得到 503。这里走 Better Auth 的标准注册接口：
  // 开发环境不启用 Turnstile，接口直接建号并下发会话 cookie。
  const signUp = await page.request.post('/api/auth/sign-up/email', {
    data: { name: `E2E Retry ${suffix}`, email, password: 'e2e-local-password-1' },
    headers: { Origin: baseURL },
  });
  expect(signUp.ok(), await signUp.text()).toBeTruthy();
  const session = await page.request.get('/api/auth/get-session');
  const sessionBody = (await session.json()) as { user?: { email?: string } } | null;
  expect(sessionBody?.user?.email).toBe(email);

  const userId = await userIdFor(email);
  createdUserIds.push(userId);

  /* ---- 2. 配一个指向假模型的 Provider ---- */
  const providerResponse = await page.request.post('/api/providers', {
    data: {
      provider: {
        name: `E2E Mock ${suffix}`,
        baseUrl: mockBaseUrl,
        model: 'mock-model',
        apiKey: 'mock-api-key',
      },
    },
    headers: { Origin: baseURL },
  });
  expect(providerResponse.ok(), await providerResponse.text()).toBeTruthy();

  /* ---- 3. 上传一本真实 EPUB ---- */
  const epub = await fs.readFile(path.join(projectRoot, 'tests/book-engine/fixtures/sample-book.epub'));
  const upload = await page.request.post('/api/books/upload?filename=sample-book.epub', {
    data: epub,
    headers: { 'content-type': 'application/epub+zip', Origin: baseURL },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const { book } = (await upload.json()) as { book: { bookId: string } };
  const bookId = book.bookId;

  const chaptersResponse = await page.request.get(`/api/books/${bookId}/chapters`);
  expect(chaptersResponse.ok()).toBeTruthy();
  const chaptersBody = (await chaptersResponse.json()) as {
    chapters: Array<{ index: number; title: string; href: string; rewritable?: boolean }>;
  };
  const chapter = chaptersBody.chapters.find((c) => c.rewritable !== false);
  if (!chapter) throw new Error('fixture has no rewritable chapter');

  const statusPath = path.join(
    projectRoot,
    'data',
    'users',
    userId,
    'workspace',
    'books',
    bookId,
    'chapters',
    String(chapter.index).padStart(3, '0'),
    'status.json',
  );
  const markFailed = async () => {
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(
      statusPath,
      JSON.stringify({
        index: chapter.index,
        title: chapter.title,
        href: chapter.href,
        stage: 'failed',
        error: 'E2E 故意标记失败，用来验证「重试」',
        chunkTotal: 1,
        chunkDone: 1,
        quality: null,
        usage: null,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );
  };

  /* ---- 4. 点「重试」：按钮必须立刻进入忙碌状态，任务必须真的跑完 ---- */
  await markFailed();
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(`/zh-CN/dashboard/library/${bookId}`);
  const retryButton = page.getByRole('button', { name: '重试', exact: true }).first();
  await expect(retryButton).toBeVisible({ timeout: 30_000 });
  await retryButton.scrollIntoViewIfNeeded();
  await retryButton.click();

  const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    // 旧故障里这一下只会弹 409，一行任务都不会建（这本书此前没有任何任务行）。
    await expect
      .poll(
        async () => {
          const rows = await client<{ id: string }[]>`
            SELECT id FROM book_jobs WHERE book_id = ${bookId}
          `;
          return rows.length;
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBeGreaterThan(0);

    await expect
      .poll(
        async () => {
          const rows = await client<{ status: string }[]>`
            SELECT status FROM book_jobs WHERE book_id = ${bookId} ORDER BY created_at DESC LIMIT 1
          `;
          return rows[0]?.status ?? 'missing';
        },
        { timeout: 120_000, intervals: [1000] },
      )
      // 关键回归：任务行必须被后台镜像收尾成 done。
      // 两套 bundle 各有一份 JobManager 时，这一行会永远停在 running。
      .toBe('done');

    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/books/${bookId}/chapters`);
          const body = (await response.json()) as {
            chapters: Array<{ index: number; stage: string }>;
          };
          return body.chapters.find((c) => c.index === chapter.index)?.stage ?? 'missing';
        },
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe('completed');

    /* ---- 5. 再制造一次「已有任务在运行」：409 提示必须滚进视口 ---- */
    await markFailed();
    await client`
      INSERT INTO book_jobs (id, user_id, book_id, kind, status, payload, progress, updated_at)
      VALUES (${`e2e-live-${suffix}`}, ${userId}, ${bookId}, 'rewrite', 'running', '{}'::jsonb, '{}'::jsonb, now())
    `;
    await page.reload();
    const retryAgain = page.getByRole('button', { name: '重试', exact: true }).first();
    await expect(retryAgain).toBeVisible({ timeout: 30_000 });
    await retryAgain.scrollIntoViewIfNeeded();
    await retryAgain.click();

    const alert = page.locator('[data-book-error]');
    await expect(alert).toContainText('这本书已有任务在运行中', { timeout: 10_000 });
    // 修之前错误横幅在页面顶部、离当前滚动位置很远；修之后会滚到视野中央。
    await expect(alert).toBeInViewport();
  } finally {
    await client`DELETE FROM book_jobs WHERE id = ${`e2e-live-${suffix}`}`.catch(() => {});
    await client.end({ timeout: 5 });
  }
});
