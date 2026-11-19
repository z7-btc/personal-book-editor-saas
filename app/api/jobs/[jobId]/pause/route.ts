import { getBookJob, pauseBookJob } from '@/lib/book-store/job-runner';
import { assertSameOrigin, withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ jobId: string }> };

/** POST /api/jobs/:jobId/pause —— 暂停任务（先按归属校验，别人的一律 404）。 */
export async function POST(request: Request, { params }: Params) {
  return withBookApi(request, async (userId) => {
    assertSameOrigin(request);
    const { jobId } = await params;
    await getBookJob(userId, jobId); // 归属校验；不存在/不是我的 → 404
    const job = await pauseBookJob(userId, jobId);
    return { job };
  });
}
