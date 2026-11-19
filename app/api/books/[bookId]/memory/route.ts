import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import { assertSameOrigin, readJsonBody, withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ bookId: string }> };

/** GET /api/books/:bookId/memory —— 这本书的 Book Memory。 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId } = await params;
    assertSafeBookId(bookId);
    return { memory: await ws.readBookMemory(bookId) };
  });
}

/** PUT / POST /api/books/:bookId/memory —— 手动改 Book Memory。 */
export async function PUT(request: Request, { params }: Params) {
  return writeMemory(request, params);
}

export async function POST(request: Request, { params }: Params) {
  return writeMemory(request, params);
}

async function writeMemory(request: Request, params: Params['params']) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const { bookId } = await params;
    assertSafeBookId(bookId);
    const body = await readJsonBody<{ memory?: unknown }>(request);
    return { memory: await ws.writeBookMemory(bookId, body.memory || body) };
  });
}
