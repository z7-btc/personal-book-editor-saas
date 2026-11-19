import fsp from 'node:fs/promises';
import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { fileResponse, withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string }> };

/** GET /api/books/:bookId/original —— 下载原始 EPUB。 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId } = await params;
    assertSafeBookId(bookId);
    const metadata = (await ws.readBookMetadata(bookId)) as {
      title?: string;
      sourceFileName?: string;
    };
    const buffer = await fsp.readFile(ws.bookPaths(bookId).original);
    return fileResponse(buffer, {
      contentType: 'application/epub+zip',
      fileName: metadata.sourceFileName || `${metadata.title || 'book'}.epub`,
      download: true,
    });
  });
}
