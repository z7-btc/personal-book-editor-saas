import { loadProfile } from '@/lib/book-engine/config/profile.js';
import { importBook } from '@/lib/book-engine/pipeline/book-service.js';
import { decorate } from '@/lib/book-store/book-view';
import { syncBookIndex } from '@/lib/book-store/book-index';
import {
  assertSameOrigin,
  privateHeaders,
  readRawBody,
  withBookApi,
} from '@/lib/book-store/api-helpers';
import { projectRoot } from '@/lib/book-store/storage';

/**
 * POST /api/books/upload?filename=xxx.epub —— 导入一本 EPUB。
 *
 * 请求体就是文件字节（application/epub+zip），文件名走 query，
 * 与前端 `fetch(url, { body: file })` 直接对接，不做 multipart 解析。
 */
export async function POST(request: Request) {
  return withBookApi(request, async (userId) => {
    assertSameOrigin(request);
    const fileName = new URL(request.url).searchParams.get('filename') || 'book.epub';
    const buffer = await readRawBody(request);
    const profile = await loadProfile(projectRoot());
    const metadata = (await importBook({ buffer, fileName, profile })) as { bookId: string };
    await syncBookIndex(userId, metadata.bookId);
    const book = await decorate(metadata.bookId);
    return Response.json({ book }, { status: 201, headers: privateHeaders });
  });
}
