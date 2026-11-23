'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import {
  ApiError,
  booksApi,
  formatBytes,
  formatDate,
  type BookDetail,
  type PlanView,
  type ProviderView,
  type ReportView,
  type RewriteStatus,
  type SettingsPayload,
} from './api';
import { isActiveJob, useJobs } from './jobs-provider';
import ChapterTable from './chapter-table';

export default function BookClient({ bookId }: { bookId: string }) {
  const t = useTranslations('Books');
  const locale = useLocale();
  const { version, jobs, refresh } = useJobs();

  const [book, setBook] = useState<BookDetail | null>(null);
  const [status, setStatus] = useState<RewriteStatus | null>(null);
  const [plan, setPlan] = useState<PlanView>(null);
  const [report, setReport] = useState<ReportView | null>(null);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [provider, setProvider] = useState<{ activeId: string | null; providers: ProviderView[] } | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);

  /**
   * 错误提示在页面顶部，而用户在章节表格上点「重试」时往往已经滚到很下面。
   * 报错落在屏幕外，看起来就是「点了没反应」。错误一出现就把它滚到视野中央，
   * 至少让用户看到到底发生了什么。
   */
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [error]);

  const load = useCallback(async () => {
    try {
      const detail = await booksApi.get(bookId);
      setBook(detail.book);
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setError(err instanceof ApiError ? err.message : t('common.error'));
      return;
    }
    // 其余几块互相独立，任何一块失败都不该让页面白屏
    const [statusData, planData, reportData, settingsData, providerData] = await Promise.all([
      booksApi.status(bookId).catch(() => null),
      booksApi.plan(bookId).catch(() => ({ plan: null })),
      booksApi.report(bookId).catch(() => ({ report: null })),
      booksApi.settings().catch(() => null),
      booksApi.providers().catch(() => null),
    ]);
    setStatus(statusData);
    setPlan(planData.plan);
    setReport(reportData.report);
    setSettings(settingsData);
    setProvider(providerData ? { activeId: providerData.activeId, providers: providerData.providers } : null);
  }, [bookId, t]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load, version]);

  const activeJob = jobs.find((job) => job.bookId === bookId && (isActiveJob(job) || job.status === 'paused'));
  const running = Boolean(activeJob) || Boolean(status?.running);

  async function ensureProvider(): Promise<boolean> {
    try {
      const check = await booksApi.checkProvider();
      if (!check.ok) {
        setNotice(t('book.actions.configRequired'));
        setError('');
        return false;
      }
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
      return false;
    }
  }

  async function startJob(key: string, run: () => Promise<unknown>, confirmText?: string) {
    if (busy) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(key);
    setError('');
    setNotice('');
    try {
      if (!(await ensureProvider())) return;
      await run();
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(null);
    }
  }

  if (notFound) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-900">
        <p className="font-medium">{t('book.notFound')}</p>
        <Link href="/dashboard/library" className="mt-3 inline-block text-sm underline underline-offset-4">
          {t('book.back')}
        </Link>
      </div>
    );
  }

  if (!book) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>;
  }

  const chapters = book.chapters || [];
  const rewritable = chapters.filter((c) => c.rewritable !== false);
  const words = chapters.reduce((sum, c) => sum + (c.textLength || 0), 0);
  const planCounts = (plan?.entries || []).reduce<Record<string, number>>((acc, entry) => {
    acc[entry.strategy] = (acc[entry.strategy] || 0) + 1;
    return acc;
  }, {});
  const activeProvider = provider?.providers.find((p) => p.id === provider.activeId) || null;
  const remaining = status?.remaining ?? 0;
  const failedCount = book.progress.failed;

  const mainButton = 'rounded-md bg-gray-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white';
  const subButton = 'rounded-md border border-gray-200 px-3.5 py-2 text-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800';

  return (
    <div className="space-y-8">
      {/* 头部 */}
      <header className="space-y-2">
        <Link href="/dashboard/library" className="text-xs text-gray-500 hover:underline dark:text-gray-400">
          ← {t('book.back')}
        </Link>
        <h1 className="text-2xl font-semibold leading-tight">{book.title}</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {(book.authors || []).join(' / ') || '—'}
          {book.language ? ` · ${book.language}` : ''}
          {book.sourceSize ? ` · ${formatBytes(book.sourceSize)}` : ''}
          {book.updatedAt ? ` · ${formatDate(book.updatedAt, locale)}` : ''}
        </p>
        {(book.warnings || []).length > 0 && (
          <ul className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
            {(book.warnings || []).map((warning, i) => (
              <li key={i}>· {warning}</li>
            ))}
          </ul>
        )}
      </header>

      {/* 统计 */}
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-gray-200 bg-gray-200 text-sm dark:border-gray-700 dark:bg-gray-700 sm:grid-cols-3 lg:grid-cols-6">
        {[
          [t('book.stats.chapters'), String(book.chapterCount)],
          [t('book.stats.words'), new Intl.NumberFormat(locale).format(words)],
          [t('book.stats.rewritable'), String(rewritable.length)],
          [t('book.stats.done'), String(book.progress.completed)],
          [t('book.stats.failed'), String(book.progress.failed)],
          [t('book.stats.exports'), String(book.exports.length)],
        ].map(([label, value]) => (
          <div key={label} className="bg-white px-4 py-3 dark:bg-gray-900">
            <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
            <dd className="mt-0.5 font-medium">{value}</dd>
          </div>
        ))}
      </dl>

      {/* 上次没做完 */}
      {!running && status?.pending && remaining > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-900 dark:text-amber-200">{t('book.resume.title')}</p>
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            {t('book.resume.reason', { reason: status.pending.reason || t('common.unknown') })}
          </p>
          <p className="mt-1 text-amber-800 dark:text-amber-300">
            {t('book.resume.progress', { done: status.done, total: status.total })}
            {status.pending.partialChapters?.length
              ? ` · ${t('book.resume.partial', { count: status.pending.partialChapters.length })}`
              : ''}
            {status.pending.failedChapters?.length
              ? ` · ${t('book.resume.failed', { count: status.pending.failedChapters.length })}`
              : ''}
          </p>
          {status.pending.updatedAt && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              {t('book.resume.stoppedAt', { time: formatDate(status.pending.updatedAt, locale) })}
            </p>
          )}
          <button
            type="button"
            onClick={() =>
              startJob(
                'resume',
                () => booksApi.rewrite({ bookId, mode: 'resume', resume: true }),
                t('book.actions.resumeConfirm', { count: remaining }),
              )
            }
            disabled={Boolean(busy) || running}
            className={`${mainButton} mt-3`}
          >
            {t('book.resume.continue', { count: remaining })}
          </button>
        </div>
      )}

      {/* 操作区 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => startJob('auto', () => booksApi.auto(bookId), t('book.actions.autoConfirm'))}
          disabled={Boolean(busy) || running}
          className={mainButton}
        >
          {busy === 'auto' ? t('common.loading') : t('book.actions.auto')}
        </button>

        <button
          type="button"
          onClick={() =>
            startJob(
              'plan',
              () => booksApi.startPlan(bookId),
              plan?.entries?.length
                ? t('book.actions.planConfirmExisting', {
                    keep: planCounts.keep || 0,
                    digest: planCounts.digest || 0,
                    drop: planCounts.drop || 0,
                  })
                : t('book.actions.planConfirm'),
            )
          }
          disabled={Boolean(busy) || running}
          className={subButton}
        >
          {plan?.entries?.length ? t('book.actions.replan') : t('book.actions.plan')}
        </button>

        {remaining > 0 && (
          <button
            type="button"
            onClick={() =>
              startJob(
                'resume',
                () => booksApi.rewrite({ bookId, mode: 'resume', resume: true }),
                t('book.actions.resumeConfirm', { count: remaining }),
              )
            }
            disabled={Boolean(busy) || running}
            className={subButton}
          >
            {t('book.actions.resume', { count: remaining })}
          </button>
        )}

        <button
          type="button"
          onClick={() =>
            startJob('all', () => booksApi.rewrite({ bookId, mode: 'all' }), t('book.actions.rewriteAllConfirm'))
          }
          disabled={Boolean(busy) || running}
          className={subButton}
        >
          {t('book.actions.rewriteAll')}
        </button>

        {failedCount > 0 && (
          <button
            type="button"
            onClick={() =>
              startJob(
                'failed',
                () => booksApi.rewrite({ bookId, mode: 'failed' }),
                t('book.actions.retryFailedConfirm', { count: failedCount }),
              )
            }
            disabled={Boolean(busy) || running}
            className={subButton}
          >
            {t('book.actions.retryFailed', { count: failedCount })}
          </button>
        )}

        <button
          type="button"
          onClick={async () => {
            if (busy) return;
            setBusy('export');
            setError('');
            setNotice('');
            try {
              const result = await booksApi.exportBook(bookId);
              const name = (result.export as { fileName?: string; name?: string }).fileName
                || (result.export as { name?: string }).name;
              setBook(result.book);
              if (name) window.location.href = booksApi.exportDownloadUrl(bookId, name);
              refresh();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : t('common.error'));
            } finally {
              setBusy(null);
            }
          }}
          disabled={Boolean(busy)}
          className={subButton}
        >
          {busy === 'export' ? t('book.actions.exporting') : t('book.actions.export')}
        </button>

        <button
          type="button"
          onClick={() => startJob('extract', () => booksApi.extractAll(bookId), t('book.actions.extractAllConfirm'))}
          disabled={Boolean(busy) || running}
          className={subButton}
        >
          {busy === 'extract' ? t('book.actions.extracting') : t('book.actions.extractAll')}
        </button>

        {running && activeJob && (
          <button
            type="button"
            onClick={async () => {
              try {
                await booksApi.pauseJob(activeJob.id);
                refresh();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : t('common.error'));
              }
            }}
            className={subButton}
          >
            {t('book.actions.pause')}
          </button>
        )}

        <button type="button" onClick={() => void load()} disabled={Boolean(busy)} className={subButton}>
          {t('book.actions.refresh')}
        </button>
      </div>

      {activeJob && (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm dark:border-gray-700 dark:bg-gray-800">
          {t('book.actions.running')}
          {activeJob.message ? ` · ${activeJob.message}` : ''}
        </p>
      )}

      {notice && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <span>{notice}</span>
          <Link href="/dashboard/settings" className="font-medium underline underline-offset-4">
            {t('book.actions.goSettings')}
          </Link>
        </div>
      )}

      {error && (
        <p
          ref={errorRef}
          data-book-error
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {/* 三张配置卡 */}
      <div className="grid gap-4 md:grid-cols-3">
        <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-sm font-semibold">{t('book.provider.title')}</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {activeProvider
              ? t('book.provider.ok', {
                  name: activeProvider.name || activeProvider.id,
                  model: activeProvider.model || t('common.unknown'),
                })
              : t('book.provider.missing')}
          </p>
          <Link href="/dashboard/settings" className="mt-2 inline-block text-sm underline underline-offset-4">
            {t('book.provider.go')}
          </Link>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-sm font-semibold">{t('book.memory.title')}</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {settings?.settings.memory?.enabled === false ? t('book.memory.off') : t('book.memory.on')}
          </p>
          <Link href="/dashboard/settings" className="mt-2 inline-block text-sm underline underline-offset-4">
            {t('book.memory.go')}
          </Link>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-sm font-semibold">{t('book.promptsCard.title')}</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t('book.promptsCard.desc')}</p>
          <Link href="/dashboard/prompts" className="mt-2 inline-block text-sm underline underline-offset-4">
            {t('book.promptsCard.go')}
          </Link>
        </section>
      </div>

      {/* 章节方案 */}
      <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">{t('book.plan.title')}</h2>
          {plan?.updatedAt && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t('book.plan.updatedAt', { date: formatDate(plan.updatedAt, locale) })}
            </span>
          )}
        </div>

        {!plan?.entries?.length ? (
          <div className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            <p className="font-medium text-gray-900 dark:text-gray-100">{t('book.plan.empty')}</p>
            <p className="mt-1">{t('book.plan.emptyHint')}</p>
          </div>
        ) : (
          <>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              {[
                [t('book.plan.deep'), planCounts.keep || 0],
                [t('book.plan.digest'), planCounts.digest || 0],
                [t('book.plan.skip'), planCounts.skip || 0],
                [t('book.plan.drop'), planCounts.drop || 0],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800">
                  <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
                  <dd className="font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            {plan.overview && (
              <div className="mt-3">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{t('book.plan.overview')}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{plan.overview}</p>
              </div>
            )}
            {(plan.warnings || []).length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                <p className="font-medium">{t('book.plan.warnings')}</p>
                <ul className="mt-1 space-y-1">
                  {(plan.warnings || []).map((warning, i) => (
                    <li key={i}>· {warning}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      {/* 成品体检 */}
      {report && (report.removed.count > 0 || report.compressed.count > 0 || report.plainLanguage.count > 0) && (
        <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-lg font-semibold">{t('book.report.title')}</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t('book.report.chapters')}: {report.original.chapters} · {t('book.report.words')}:{' '}
            {new Intl.NumberFormat(locale).format(report.original.chars)} →{' '}
            {new Intl.NumberFormat(locale).format(report.result.chars)}{' '}
            <span className="text-xs">({t('book.report.ratio', { ratio: report.result.ratio.toFixed(2) })})</span>
          </p>

          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 lg:grid-cols-5">
            {[
              [t('book.report.removed'), report.removed.count],
              [t('book.report.compressed'), report.compressed.count],
              [t('book.report.plain'), report.plainLanguage.count],
              [t('book.report.kept'), report.unchanged.count],
              [t('book.report.renamed'), report.renamed],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-800">
                <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
          </dl>

          {report.notes.total > 0 && (
            <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
              {t('book.report.footnotes')}: {t('book.report.footnotesInlined', { count: report.notes.inlined })} ·{' '}
              {t('book.report.footnotesDropped', { count: report.notes.dropped })} ·{' '}
              {t('book.report.footnotesKept', { count: report.notes.kept })}
            </p>
          )}

          {report.export && (
            <div className="mt-3 rounded-lg border border-gray-100 px-3 py-2 text-xs text-gray-600 dark:border-gray-800 dark:text-gray-400">
              <p className="font-medium text-gray-700 dark:text-gray-300">{t('book.report.health')}</p>
              <ul className="mt-1 grid gap-1 sm:grid-cols-2">
                <li>
                  {t('book.report.healthFile')}: {report.export.entries ?? '—'}
                </li>
                <li>
                  {t('book.report.healthSpine')}: {report.export.spineChapters ?? '—'}
                </li>
                <li>
                  {t('book.report.healthToc')}: {report.export.tocEntries ?? '—'}
                </li>
                <li>
                  {t('book.report.healthLinks')}: {report.export.links ?? '—'} · {t('book.report.healthDead')}:{' '}
                  {report.export.deadLinks ?? 0} · {t('book.report.healthAnchor')}: {report.export.anchorLost ?? 0}
                </li>
              </ul>
            </div>
          )}

          {(report.removed.chapters.length > 0 || report.compressed.chapters.length > 0) && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400">
                {t('book.report.details')}
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-gray-600 dark:text-gray-400">
                {report.removed.chapters.map((c) => (
                  <li key={`rm-${c.index}`}>
                    − {c.index}. {c.title} ({new Intl.NumberFormat(locale).format(c.chars)})
                  </li>
                ))}
                {report.compressed.chapters.map((c) => (
                  <li key={`cp-${c.index}`}>
                    ↓ {c.index}. {c.title} ({new Intl.NumberFormat(locale).format(c.before)} →{' '}
                    {new Intl.NumberFormat(locale).format(c.after)})
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {/* 章节表 */}
      <ChapterTable
        bookId={bookId}
        chapters={chapters}
        busy={busy}
        onRewrite={(index) =>
          void startJob(`rewrite-${index}`, () => booksApi.rewriteChapter(bookId, index))
        }
        onRetry={(index) => void startJob(`rewrite-${index}`, () => booksApi.retryChapter(bookId, index))}
        onReset={(index) => {
          const chapter = chapters.find((c) => c.index === index);
          void startJob(`reset-${index}`, () => booksApi.resetChapter(bookId, index), t('book.chapters.resetConfirm', {
            title: chapter?.title || String(index),
          }));
        }}
        onRewriteSelected={(indexes) =>
          void startJob('selected', () => booksApi.rewrite({ bookId, chapters: indexes, mode: 'selected' }))
        }
      />

      {/* 导出记录 */}
      <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="text-lg font-semibold">{t('book.exports.title')}</h2>
        {book.exports.length === 0 ? (
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('book.exports.empty')}</p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-100 text-sm dark:divide-gray-800">
            {book.exports.map((file) => (
              <li key={file.name} className="flex flex-wrap items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">{formatBytes(file.size)}</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">{formatDate(file.createdAt, locale)}</span>
                <a
                  href={booksApi.exportDownloadUrl(bookId, file.name)}
                  className="rounded-md border border-gray-200 px-2.5 py-1 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                >
                  {t('book.exports.download')}
                </a>
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.confirm(t('book.exports.deleteConfirm', { name: file.name }))) return;
                    try {
                      await booksApi.deleteExport(bookId, file.name);
                      await load();
                    } catch (err) {
                      setError(err instanceof ApiError ? err.message : t('common.error'));
                    }
                  }}
                  className="rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-950 dark:hover:text-red-400"
                >
                  {t('common.delete')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <a
          href={booksApi.originalDownloadUrl(bookId)}
          className="mt-3 inline-block text-xs text-gray-500 underline underline-offset-4 dark:text-gray-400"
        >
          {t('book.chapters.original')} · EPUB
        </a>
      </section>
    </div>
  );
}
