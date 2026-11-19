import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string }> };

/** GET /api/books/:bookId/exports —— 已有的成品列表。 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId } = await params;
    assertSafeBookId(bookId);
    return { exports: await ws.listExports(bookId) };
  });
}
