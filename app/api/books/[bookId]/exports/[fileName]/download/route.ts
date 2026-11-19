import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { fileResponse, withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string; fileName: string }> };

/** GET /api/books/:bookId/exports/:fileName/download —— 下载成品 EPUB。 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId, fileName } = await params;
    assertSafeBookId(bookId);
    const { buffer, fileName: actualName } = (await ws.readExport(bookId, fileName)) as {
      buffer: Buffer;
      fileName: string;
    };
    return fileResponse(buffer, {
      contentType: 'application/epub+zip',
      fileName: actualName,
      download: true,
    });
  });
}
