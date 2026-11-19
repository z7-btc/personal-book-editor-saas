import { getBookJob } from '@/lib/book-store/job-runner';
import { withBookApi } from '@/lib/book-store/api-helpers';

type Params = { params: Promise<{ jobId: string }> };

/** GET /api/jobs/:jobId —— 单个任务状态（内存活着的给实时状态）。 */
export async function GET(request: Request, { params }: Params) {
  return withBookApi(request, async (userId) => {
    const { jobId } = await params;
    const result = await getBookJob(userId, jobId);
    return result;
  });
}
