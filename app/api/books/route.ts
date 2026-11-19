import { withBookApi } from '@/lib/book-store/api-helpers';
import { listUserBooks, syncAllBooksFromDisk } from '@/lib/book-store/book-index';

/**
 * GET /api/books —— 当前用户的书库列表。
 *
 * 列表只查数据库里的"目录卡"（速度与分页都靠 SQL）；
 * 卡片由导入/删除/任务结束时写入。如果用户是第一次登录、
 * 磁盘上已有老书（从单人版迁移过来的情况），库里还没有卡片，
 * 则整库重建一次。
 */
export async function GET(request: Request) {
  return withBookApi(request, async (userId) => {
    let rows = await listUserBooks(userId);
    if (!rows.length) {
      const rebuilt = await syncAllBooksFromDisk(userId).catch(() => null);
      if (rebuilt && rebuilt.total > 0) rows = await listUserBooks(userId);
    }
    return { books: rows.map(toCard) };
  });
}

type IndexMetadata = {
  authors?: string[];
  language?: string;
  chapterCount?: number;
  progress?: unknown;
  exportCount?: number;
  latestExport?: { name: string; size: number; createdAt: string } | null;
  planCounts?: Record<string, number> | null;
  pendingWork?: { remaining: number; mode: string | null; reason: string | null } | null;
};

/** 数据库行 → 前端书库卡片形状（字段名对齐原项目，界面迁移不用改）。 */
function toCard(row: Awaited<ReturnType<typeof listUserBooks>>[number]) {
  const meta = (row.metadata || {}) as IndexMetadata;
  return {
    bookId: row.id,
    title: row.title,
    authors: meta.authors?.length ? meta.authors : row.author ? [row.author] : [],
    language: meta.language || '',
    chapterCount: meta.chapterCount ?? row.totalChapters,
    status: row.status,
    progress: meta.progress ?? null,
    exportCount: meta.exportCount ?? 0,
    latestExport: meta.latestExport ?? null,
    processed: meta.planCounts ? { counts: meta.planCounts } : null,
    pendingWork: meta.pendingWork ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
