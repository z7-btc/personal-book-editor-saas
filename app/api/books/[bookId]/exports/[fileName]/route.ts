import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { assertSameOrigin, withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string; fileName: string }> };

/** DELETE /api/books/:bookId/exports/:fileName —— 删一份成品。 */
export async function DELETE(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const { bookId, fileName } = await params;
    assertSafeBookId(bookId);
    // Next 已经解过码，这里不能再 decodeURIComponent 一次
    const result = await ws.deleteExport(bookId, fileName);
    return result;
  });
}
