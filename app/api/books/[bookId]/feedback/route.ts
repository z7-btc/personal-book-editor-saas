import * as ws from '@/lib/book-engine/pipeline/workspace.js';
import { loadProfile, suggestProfileFromFeedback } from '@/lib/book-engine/config/profile.js';
import { assertSafeBookId } from '@/lib/book-engine/util/ids.js';
import {
  assertSameOrigin,
  privateHeaders,
  readJsonBody,
  withBookApi,
} from '@/lib/book-store/api-helpers';
import { projectRoot } from '@/lib/book-store/storage';

type Params = { params: Promise<{ bookId: string }> };

type FeedbackFile = { entries: Array<{ id: string; [key: string]: unknown }> };
type FeedbackBody = {
  action?: string;
  text?: string;
  tags?: unknown;
  rating?: unknown;
};

/** GET /api/books/:bookId/feedback —— 这本书收到的反馈。 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    const { bookId } = await params;
    assertSafeBookId(bookId);
    return { feedback: await ws.readBookFeedback(bookId) };
  });
}

/**
 * POST /api/books/:bookId/feedback —— 记一条反馈；
 * `action: 'suggest'` 时只给画像改进建议、不落盘。
 */
export async function POST(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const { bookId } = await params;
    assertSafeBookId(bookId);
    const body = await readJsonBody<FeedbackBody>(request);

    if (body.action === 'suggest') {
      const profile = await loadProfile(projectRoot());
      const suggestion = suggestProfileFromFeedback(
        profile,
        String(body.text || ''),
        Array.isArray(body.tags) ? body.tags : [],
      );
      return { suggestion };
    }

    const feedback = (await ws.readBookFeedback(bookId)) as FeedbackFile;
    const entry = {
      id: `fb_${Date.now().toString(36)}`,
      text: String(body.text || '').slice(0, 4000),
      tags: Array.isArray(body.tags) ? body.tags.slice(0, 20) : [],
      rating: typeof body.rating === 'number' ? body.rating : null,
      createdAt: new Date().toISOString(),
    };
    feedback.entries.push(entry);
    await ws.writeBookFeedback(bookId, feedback);
    return Response.json({ feedback, entry }, { status: 201, headers: privateHeaders });
  });
}

/** DELETE /api/books/:bookId/feedback?id=... —— 删一条反馈。 */
export async function DELETE(request: Request, { params }: Params) {
  return withBookApi(request, async () => {
    assertSameOrigin(request);
    const { bookId } = await params;
    assertSafeBookId(bookId);
    const id = new URL(request.url).searchParams.get('id');
    const feedback = (await ws.readBookFeedback(bookId)) as FeedbackFile;
    feedback.entries = feedback.entries.filter((e) => e.id !== id);
    await ws.writeBookFeedback(bookId, feedback);
    return { feedback };
  });
}
