import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { NotFoundError } from '@/lib/book-engine/util/errors.js';
import { decorate } from '@/lib/book-store/book-view';
import { removeBookIndex } from '@/lib/book-store/book-index';
import { assertSameOrigin, withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string }> };

/** GET /api/books/:bookId —— 书籍详情（工作台首屏）。 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId } = await params;
    assertSafeBookId(bookId);
    return { book: await decorate(bookId) };
  });
}

/** DELETE /api/books/:bookId —— 删书（磁盘 + 索引里的卡片与任务记录）。 */
export async function DELETE(request: Request, { params }: Params) {
  return withBookApi(request, async (userId) => {
    assertSameOrigin(request);
    const { bookId } = await params;
    assertSafeBookId(bookId);
    // 不存在的书（包括别人的书）一律 404：引擎的删除对不存在的目录是静默成功的，
    // 不先查一下，删别人的书会"看起来成功"。
    if (!(await ws.bookExists(bookId))) throw new NotFoundError('书籍不存在');
    const result = await ws.deleteBook(bookId);
    await removeBookIndex(userId, bookId);
    return result;
  });
}
