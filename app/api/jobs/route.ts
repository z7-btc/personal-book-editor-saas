import { listBookJobs } from '@/lib/book-store/job-runner';
import { withBookApi } from '@/lib/book-store/api-helpers';

/**
 * GET /api/jobs —— 我的任务清单。
 *
 * jobs 是本进程里正在跑的（实时进度）；history 是数据库里存过的记录
 * （重启前的、已结束的），同一个任务以实时状态为准、不会重复出现。
 */
export async function GET(request: Request) {
  return withBookApi(request, async (userId) => listBookJobs(userId));
}
