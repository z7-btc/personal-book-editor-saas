'use client';

/**
 * 任务中心：全站共享的「正在跑什么」。
 *
 * 原项目把轮询写在 main.js 里、每个页面自己再刷新一遍；React 版把
 * 轮询收进一个 Provider：
 *  - 有任务在跑 → 1.5 秒问一次；全部空闲 → 5 秒问一次（便宜的心跳）。
 *  - 每次问完把 version +1，页面订阅它就能原地刷新，不用各自开定时器。
 *  - 左下角任务坞显示进度、暂停、跳回书籍。
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { booksApi, formatDuration, type JobHistoryRow, type JobView } from './api';

const FAST_POLL_MS = 1500;
const IDLE_POLL_MS = 5000;
const FINISHED_TTL_MS = 60_000;

export type FinishedJob = { job: JobHistoryRow; at: number };

type JobsContextValue = {
  jobs: JobView[];
  history: JobHistoryRow[];
  finished: FinishedJob[];
  /** 每成功轮询一次 +1；页面据此重新拉自己的数据。 */
  version: number;
  refresh: () => void;
  pause: (jobId: string) => Promise<void>;
};

const JobsContext = createContext<JobsContextValue | null>(null);

const ACTIVE = new Set(['queued', 'running', 'pausing']);

export function isActiveJob(job: { status: string }): boolean {
  return ACTIVE.has(job.status);
}

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [history, setHistory] = useState<JobHistoryRow[]>([]);
  const [finished, setFinished] = useState<FinishedJob[]>([]);
  const [version, setVersion] = useState(0);
  const [nonce, setNonce] = useState(0);
  const previous = useRef<Map<string, JobView>>(new Map());
  const activeRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const data = await booksApi.jobs();
        if (cancelled) return;

        // 刚跑完的任务：从实时列表消失的一瞬间，去历史里取最终状态，
        // 让用户看到「完成 / 失败」，而不是任务坞凭空消失。
        const now = Date.now();
        const liveIds = new Set(data.jobs.map((j) => j.id));
        const vanished: JobView[] = [];
        for (const [id, job] of previous.current) {
          if (!liveIds.has(id)) vanished.push(job);
        }
        if (vanished.length) {
          setFinished((prev) => {
            const next = [...prev];
            for (const old of vanished) {
              const row = data.history.find((h) => h.id === old.id);
              if (row) next.push({ job: row, at: now });
            }
            return next.filter((item) => now - item.at < FINISHED_TTL_MS);
          });
        } else {
          setFinished((prev) => prev.filter((item) => now - item.at < FINISHED_TTL_MS));
        }

        const map = new Map<string, JobView>();
        for (const job of data.jobs) map.set(job.id, job);
        previous.current = map;
        activeRef.current = data.jobs.some((job) => isActiveJob(job));

        setJobs(data.jobs);
        setHistory(data.history);
        setVersion((n) => n + 1);
      } catch {
        // 断网/未登录：静默重试；页面本身会处理登录态
        activeRef.current = true;
      }
      if (!cancelled) {
        timer = setTimeout(load, activeRef.current ? FAST_POLL_MS : IDLE_POLL_MS);
      }
    }

    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const pause = useCallback(async (jobId: string) => {
    await booksApi.pauseJob(jobId);
    setNonce((n) => n + 1);
  }, []);

  return (
    <JobsContext.Provider value={{ jobs, history, finished, version, refresh, pause }}>
      {children}
      <JobDock />
    </JobsContext.Provider>
  );
}

export function useJobs(): JobsContextValue {
  const ctx = useContext(JobsContext);
  if (!ctx) throw new Error('useJobs 必须在 JobsProvider 里使用');
  return ctx;
}

/* ------------------------------------------------------------------ 任务坞 -- */

type DockItem = { key: string; job: JobView | JobHistoryRow; finished: boolean };

function dockProgress(job: JobView | JobHistoryRow) {
  const live = job as JobView;
  const hist = job as JobHistoryRow;
  return {
    done: live.completed?.length ?? hist.progress?.completed?.length ?? 0,
    failed: live.failed?.length ?? hist.progress?.failed?.length ?? 0,
    elapsed: live.elapsedMs ?? hist.progress?.elapsedMs ?? 0,
    tokens: live.usage?.totalTokens ?? 0,
    message: live.message || hist.progress?.message || '',
  };
}

export function JobDock() {
  const t = useTranslations('Books');
  const { jobs, finished, pause, refresh } = useJobs();
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const active = jobs.filter((job) => isActiveJob(job) || job.status === 'paused');
  const items: DockItem[] = [
    ...active.map((job) => ({ key: `live-${job.id}`, job, finished: false })),
    ...finished
      .filter((f) => !active.some((a) => a.id === f.job.id))
      .map((f) => ({ key: `done-${f.job.id}`, job: f.job, finished: true })),
  ];
  if (!items.length) return null;

  const runningCount = jobs.filter(isActiveJob).length;

  async function handlePause(jobId: string) {
    setBusy(jobId);
    try {
      await pause(jobId);
    } catch {
      /* 暂停失败就等下一轮轮询自己纠正 */
    } finally {
      setBusy(null);
    }
  }

  async function handleResume(job: JobView | JobHistoryRow) {
    setBusy(job.id);
    try {
      await booksApi.rewrite({ bookId: job.bookId, mode: 'resume', resume: true });
      refresh();
    } catch {
      /* 继续失败：书籍页会给详细提示 */
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed bottom-4 left-4 z-40 w-[min(22rem,calc(100vw-2rem))]">
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-900">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800"
          aria-expanded={open}
        >
          <span className="relative flex h-2 w-2 shrink-0">
            <span className={`h-2 w-2 rounded-full ${runningCount ? 'bg-emerald-500' : 'bg-gray-400'}`} />
            {runningCount > 0 && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            )}
          </span>
          <span className="flex-1 truncate">
            {t('dock.title')}
            {runningCount > 0 ? ` · ${runningCount}` : ''}
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">{open ? t('dock.hide') : t('dock.show')}</span>
        </button>

        {open && (
          <div className="max-h-[60vh] divide-y divide-gray-100 overflow-y-auto border-t border-gray-100 dark:divide-gray-800 dark:border-gray-800">
            {items.map(({ key, job, finished: isFinished }) => {
              const info = dockProgress(job);
              const total = (job as JobView).chapters?.length ?? 0;
              const paused = job.status === 'paused';
              return (
                <div key={key} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-900 dark:text-gray-100">
                      {paused ? t('dock.paused') : isFinished ? t('dock.done') : t('dock.running')}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {total ? t('dock.chapters', { done: info.done, total }) : job.kind}
                    </span>
                  </div>

                  {info.message && !isFinished && (
                    <p className="mt-1 line-clamp-2 text-xs text-gray-600 dark:text-gray-400">{info.message}</p>
                  )}

                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                    {info.failed > 0 && (
                      <span className="text-amber-600 dark:text-amber-400">
                        {t('dock.failedCount', { count: info.failed })}
                      </span>
                    )}
                    {info.elapsed > 0 && <span>{t('dock.elapsed', { time: formatDuration(info.elapsed) })}</span>}
                    {info.tokens > 0 && <span>{t('dock.tokens', { count: info.tokens.toLocaleString() })}</span>}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Link
                      href={`/dashboard/library/${job.bookId}`}
                      className="rounded-md border border-gray-200 px-2.5 py-1 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                    >
                      {t('dock.open')}
                    </Link>
                    {!isFinished && !paused && (
                      <button
                        type="button"
                        onClick={() => handlePause(job.id)}
                        disabled={busy === job.id}
                        className="rounded-md border border-gray-200 px-2.5 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
                      >
                        {t('dock.pause')}
                      </button>
                    )}
                    {paused && (
                      <button
                        type="button"
                        onClick={() => handleResume(job)}
                        disabled={busy === job.id}
                        className="rounded-md bg-gray-900 px-2.5 py-1 text-xs text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
                      >
                        {t('dock.resume')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
