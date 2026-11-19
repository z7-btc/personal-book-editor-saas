'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ApiError,
  booksApi,
  extractBody,
  type ChapterDiff,
  type ChapterRow,
} from './api';

type Props = {
  bookId: string;
  chapters: ChapterRow[];
  busy: string | null;
  onRewrite: (index: number) => void;
  onRetry: (index: number) => void;
  onReset: (index: number) => void;
  onRewriteSelected: (indexes: number[]) => void;
};

type Filter = 'all' | 'rewritable' | 'failed';
type ViewerState = { index: number; mode: 'original' | 'rewritten' | 'diff' } | null;

/** 能勾选 / 能改写：有正文，且没被整理方案要求原样保留。 */
function selectable(chapter: ChapterRow): boolean {
  return chapter.rewritable !== false && chapter.stage !== 'skipped';
}

export default function ChapterTable({
  bookId,
  chapters,
  busy,
  onRewrite,
  onRetry,
  onReset,
  onRewriteSelected,
}: Props) {
  const t = useTranslations('Books');
  const [filter, setFilter] = useState<Filter>('all');
  const [rawSelected, setRawSelected] = useState<Set<number>>(new Set());
  const [viewer, setViewer] = useState<ViewerState>(null);
  const [html, setHtml] = useState('');
  const [diff, setDiff] = useState<ChapterDiff | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState('');

  // 章节列表刷新后，已经不存在/不可选中的勾选要自动作废——不能靠 effect
  // 去改状态（那会多渲染一轮），而是在读的时候过滤掉，避免“改了 0 章”。
  const selected = useMemo(() => {
    const allowed = new Set(chapters.filter(selectable).map((c) => c.index));
    return new Set([...rawSelected].filter((index) => allowed.has(index)));
  }, [chapters, rawSelected]);

  const visible = useMemo(() => {
    if (filter === 'rewritable') return chapters.filter(selectable);
    if (filter === 'failed') return chapters.filter((c) => c.stage === 'failed');
    return chapters;
  }, [chapters, filter]);

  const selectableVisible = visible.filter(selectable);
  const allSelected = selectableVisible.length > 0 && selectableVisible.every((c) => selected.has(c.index));

  function toggle(index: number) {
    setRawSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleAll() {
    setRawSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        for (const c of selectableVisible) next.delete(c.index);
        return next;
      }
      return new Set([...prev, ...selectableVisible.map((c) => c.index)]);
    });
  }

  async function openViewer(index: number, mode: 'original' | 'rewritten' | 'diff') {
    setViewer({ index, mode });
    setViewerLoading(true);
    setViewerError('');
    setHtml('');
    setDiff(null);
    try {
      if (mode === 'diff') {
        setDiff(await booksApi.chapterDiff(bookId, index));
      } else {
        const data = await booksApi.chapterView(bookId, index, mode);
        setHtml(extractBody(data.xhtml));
      }
    } catch (err) {
      setViewerError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setViewerLoading(false);
    }
  }

  const viewerChapter = viewer ? chapters.find((c) => c.index === viewer.index) : null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          {t('book.chapters.title')} <span className="text-sm font-normal text-gray-500">({chapters.length})</span>
        </h2>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {(
            [
              ['all', t('book.chapters.filterAll')],
              ['rewritable', t('book.chapters.filterRewritable')],
              ['failed', t('book.chapters.filterFailed')],
            ] as Array<[Filter, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={`rounded-md border px-2.5 py-1 ${
                filter === value
                  ? 'border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900'
                  : 'border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm dark:border-gray-700 dark:bg-gray-800">
          <span>{t('book.chapters.selected', { count: selected.size })}</span>
          <button
            type="button"
            onClick={() => onRewriteSelected([...selected])}
            className="rounded-md bg-gray-900 px-3 py-1 text-xs font-medium text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
          >
            {t('book.chapters.rewriteSelected', { count: selected.size })}
          </button>
          <button
            type="button"
            onClick={() => setRawSelected(new Set())}
            className="text-xs text-gray-600 underline underline-offset-4 dark:text-gray-400"
          >
            {t('book.chapters.selectNone')}
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
        <table className="w-full min-w-[46rem] border-collapse text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
            <tr>
              <th className="w-8 px-2 py-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label={t('book.chapters.selectAll')}
                  disabled={selectableVisible.length === 0}
                />
              </th>
              <th className="px-2 py-2 font-medium">#</th>
              <th className="px-2 py-2 font-medium">{t('book.chapters.name')}</th>
              <th className="px-2 py-2 font-medium">{t('book.chapters.status')}</th>
              <th className="px-2 py-2 font-medium">{t('book.chapters.chunks')}</th>
              <th className="px-2 py-2 font-medium">{t('book.chapters.quality')}</th>
              <th className="px-2 py-2 text-right font-medium">{t('book.chapters.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {visible.map((chapter) => {
              const canSelect = selectable(chapter);
              const isDone = chapter.stage === 'completed';
              const canReset = chapter.stage !== 'pending' && chapter.stage !== 'skipped';
              const quality = chapter.quality;
              return (
                <tr key={chapter.index} className="align-top">
                  <td className="px-2 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(chapter.index)}
                      onChange={() => toggle(chapter.index)}
                      disabled={!canSelect}
                      aria-label={chapter.title}
                    />
                  </td>
                  <td className="px-2 py-2 text-xs text-gray-500 dark:text-gray-400">{chapter.index}</td>
                  <td className="max-w-[22rem] px-2 py-2">
                    <p className="line-clamp-2">{chapter.title}</p>
                    {chapter.note && (
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-gray-500 dark:text-gray-400">{chapter.note}</p>
                    )}
                    {chapter.error && (
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-red-600 dark:text-red-400">{chapter.error}</p>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <StageBadge stage={chapter.stage} noText={chapter.rewritable === false} />
                  </td>
                  <td className="px-2 py-2 text-xs text-gray-600 dark:text-gray-400">
                    {chapter.chunkTotal ? `${chapter.chunkDone || 0}/${chapter.chunkTotal}` : '—'}
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {quality ? (
                      <span
                        className={
                          quality.ok === false
                            ? 'text-red-600 dark:text-red-400'
                            : (quality.score ?? 1) >= 0.8
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-amber-700 dark:text-amber-400'
                        }
                        title={(quality.reasons || []).join('\n') || undefined}
                      >
                        {typeof quality.score === 'number' ? quality.score.toFixed(2) : quality.ok === false ? '!' : '✓'}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap items-center justify-end gap-1.5 text-xs">
                      <button
                        type="button"
                        onClick={() => openViewer(chapter.index, 'original')}
                        className="rounded border border-gray-200 px-2 py-0.5 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                      >
                        {t('book.chapters.original')}
                      </button>
                      {isDone && (
                        <>
                          <button
                            type="button"
                            onClick={() => openViewer(chapter.index, 'rewritten')}
                            className="rounded border border-gray-200 px-2 py-0.5 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                          >
                            {t('book.chapters.rewritten')}
                          </button>
                          <button
                            type="button"
                            onClick={() => openViewer(chapter.index, 'diff')}
                            className="rounded border border-gray-200 px-2 py-0.5 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                          >
                            {t('book.chapters.diff')}
                          </button>
                        </>
                      )}
                      {canSelect ? (
                        <button
                          type="button"
                          onClick={() => (chapter.stage === 'failed' ? onRetry(chapter.index) : onRewrite(chapter.index))}
                          disabled={busy === `rewrite-${chapter.index}`}
                          className="rounded bg-gray-900 px-2 py-0.5 text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
                        >
                          {chapter.stage === 'failed'
                            ? t('common.retry')
                            : isDone
                              ? t('book.chapters.rewriteAgain')
                              : t('book.chapters.rewrite')}
                        </button>
                      ) : (
                        <span
                          className="rounded border border-dashed border-gray-300 px-2 py-0.5 text-gray-500 dark:border-gray-600 dark:text-gray-400"
                          title={chapter.note || chapter.skippedReason || t('book.chapters.lockedHint')}
                        >
                          {t('book.stage.locked')}
                        </span>
                      )}
                      {canReset && (
                        <button
                          type="button"
                          onClick={() => onReset(chapter.index)}
                          disabled={busy === `reset-${chapter.index}`}
                          className="rounded border border-gray-200 px-2 py-0.5 text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
                        >
                          {t('book.chapters.reset')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                  {t('book.chapters.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {viewer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={viewerChapter?.title || t('book.chapters.title')}
          onClick={() => setViewer(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-gray-900"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
              <p className="mr-auto min-w-0 truncate text-sm font-medium">
                {viewer.index}. {viewerChapter?.title}
              </p>
              {(
                [
                  ['original', t('book.viewer.original')],
                  ['rewritten', t('book.viewer.rewritten')],
                  ['diff', t('book.viewer.diff')],
                ] as Array<['original' | 'rewritten' | 'diff', string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => openViewer(viewer.index, mode)}
                  className={`rounded-md px-2.5 py-1 text-xs ${
                    viewer.mode === mode
                      ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                      : 'border border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800'
                  }`}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setViewer(null)}
                className="rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                {t('common.close')}
              </button>
            </div>

            <div className="min-h-[12rem] flex-1 overflow-y-auto px-6 py-5 text-sm leading-relaxed">
              {viewerLoading ? (
                <p className="text-gray-500 dark:text-gray-400">{t('book.viewer.loading')}</p>
              ) : viewerError ? (
                <p className="text-red-600 dark:text-red-400">{viewerError}</p>
              ) : viewer.mode === 'diff' ? (
                diff ? (
                  <div>
                    <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                      {t('book.viewer.chars', { count: diff.originalChars })} →{' '}
                      {t('book.viewer.chars', { count: diff.rewrittenChars })}
                    </p>
                    {diff.diff.length === 0 ? (
                      <p className="text-gray-500 dark:text-gray-400">{t('book.viewer.diffEmpty')}</p>
                    ) : (
                      <div className="space-y-1">
                        {diff.diff.map((line, i) => (
                          <p
                            key={i}
                            className={
                              line.type === 'add'
                                ? 'rounded bg-emerald-50 px-2 py-1 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
                                : line.type === 'del'
                                  ? 'rounded bg-red-50 px-2 py-1 text-red-900 line-through decoration-red-400 dark:bg-red-950 dark:text-red-200'
                                  : 'px-2 py-1 text-gray-700 dark:text-gray-300'
                            }
                          >
                            {line.text || ' '}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null
              ) : html ? (
                // html 来自 extractBody：已经过 DOMPurify 白名单消毒（见 api.ts）。
                <div className="book-preview space-y-3" dangerouslySetInnerHTML={{ __html: html }} />
              ) : (
                <p className="text-gray-500 dark:text-gray-400">{t('book.viewer.empty')}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function StageBadge({ stage, noText }: { stage?: string; noText?: boolean }) {
  const t = useTranslations('Books');
  const key = (stage || 'pending') as
    | 'pending'
    | 'extracting'
    | 'running'
    | 'processing'
    | 'reviewing'
    | 'completed'
    | 'failed'
    | 'skipped'
    | 'locked'
    | 'paused';
  const map: Record<string, { label: string; className: string }> = {
    pending: { label: t('book.stage.pending'), className: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
    extracting: { label: t('book.stage.extracting'), className: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300' },
    running: { label: t('book.stage.running'), className: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300' },
    processing: { label: t('book.stage.running'), className: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300' },
    reviewing: { label: t('book.stage.reviewing'), className: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300' },
    completed: { label: t('book.stage.done'), className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' },
    failed: { label: t('book.stage.failed'), className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300' },
    skipped: { label: t('book.stage.skipped'), className: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' },
    locked: { label: t('book.stage.locked'), className: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400' },
    paused: { label: t('book.stage.partial'), className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  };
  const item = map[key] || map.pending;
  const active = key === 'running' || key === 'processing' || key === 'extracting' || key === 'reviewing';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${item.className}`}>
      {active && (
        <span className="inline-block h-2 w-2 animate-spin rounded-full border border-current border-t-transparent" />
      )}
      {item.label}
      {noText && <span className="opacity-70">· {t('book.chapters.noText')}</span>}
    </span>
  );
}
