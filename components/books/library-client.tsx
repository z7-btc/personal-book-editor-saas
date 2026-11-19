'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { booksApi, ApiError, formatDate, type BookCard } from './api';
import { useJobs } from './jobs-provider';

export default function LibraryClient() {
  const t = useTranslations('Books');
  const locale = useLocale();
  const router = useRouter();
  const { version } = useJobs();
  const [books, setBooks] = useState<BookCard[] | null>(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busyBook, setBusyBook] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await booksApi.list();
      setBooks(data.books);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    }
  }, [t]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load, version]);

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file || uploading) return;
    if (!/\.epub$/i.test(file.name)) {
      setError(t('library.notEpub'));
      return;
    }
    setError('');
    setUploading({ name: file.name, percent: 0 });
    try {
      const { book } = await booksApi.upload(file, (percent) => setUploading({ name: file.name, percent }));
      setUploading(null);
      router.push(`/dashboard/library/${book.bookId}`);
    } catch (err) {
      setUploading(null);
      setError(err instanceof ApiError ? err.message : t('library.uploadFailed'));
    }
  }

  async function remove(book: BookCard) {
    if (busyBook) return;
    if (!window.confirm(t('library.deleteConfirm', { title: book.title }))) return;
    setBusyBook(book.bookId);
    try {
      await booksApi.remove(book.bookId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusyBook(null);
    }
  }

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t('library.title')}</h1>
        <p className="max-w-3xl text-sm text-gray-600 dark:text-gray-400">{t('library.subtitle')}</p>
      </header>

      {/* 上传区：拖放 + 选择文件 */}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void upload(event.dataTransfer.files);
        }}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dragging
            ? 'border-gray-900 bg-gray-50 dark:border-gray-300 dark:bg-gray-800'
            : 'border-gray-200 dark:border-gray-700'
        }`}
      >
        {uploading ? (
          <div className="mx-auto max-w-md space-y-3">
            <p className="truncate text-sm text-gray-600 dark:text-gray-400">
              {t('library.uploading')} {uploading.name}
            </p>
            <div className="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800" role="progressbar" aria-valuenow={uploading.percent} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-gray-900 transition-all dark:bg-gray-100" style={{ width: `${uploading.percent}%` }} />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">{uploading.percent}%</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('library.dropHint')}{' '}
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="font-medium text-gray-900 underline underline-offset-4 dark:text-gray-100"
              >
                {t('library.chooseFile')}
              </button>
            </p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="inline-flex h-9 items-center rounded-md bg-gray-900 px-4 text-sm font-medium text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
            >
              {t('library.upload')}
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".epub,application/epub+zip"
          className="hidden"
          onChange={(event) => {
            void upload(event.target.files);
            event.target.value = '';
          }}
        />
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {books === null ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>
      ) : books.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-900">
          <p className="font-medium">{t('library.empty')}</p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t('library.emptyHint')}</p>
        </div>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {books.map((book) => {
            const p = book.progress;
            const total = p ? p.rewritable || Math.max(0, p.total - p.skipped) : 0;
            const finished = p ? p.completed + p.failed : 0;
            const percent = total ? Math.min(100, Math.round((finished / total) * 100)) : 0;
            return (
              <li
                key={book.bookId}
                className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/dashboard/library/${book.bookId}`}
                      className="line-clamp-2 font-medium hover:underline"
                    >
                      {book.title}
                    </Link>
                    <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
                      {(book.authors || []).join(' / ') || '—'} · {t('library.chapters', { count: book.chapterCount })}
                    </p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {t('library.updated', { date: formatDate(book.updatedAt || book.createdAt, locale) })}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(book)}
                    disabled={busyBook === book.bookId}
                    className="shrink-0 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-red-950 dark:hover:text-red-400"
                  >
                    {busyBook === book.bookId ? t('library.deleting') : t('common.delete')}
                  </button>
                </div>

                <div>
                  <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
                    <span>{t('library.processed', { done: finished, total })}</span>
                    <span>{percent}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                    <div className="h-full bg-gray-900 transition-all dark:bg-gray-100" style={{ width: `${percent}%` }} />
                  </div>
                  {p && (
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                      {p.completed > 0 && <span>{t('book.stats.done')}: {p.completed}</span>}
                      {p.failed > 0 && (
                        <span className="text-amber-600 dark:text-amber-400">{t('book.stats.failed')}: {p.failed}</span>
                      )}
                      {p.pending > 0 && <span>{t('library.pending', { count: p.pending })}</span>}
                      {p.skipped > 0 && <span>{t('book.stats.skipped')}: {p.skipped}</span>}
                    </div>
                  )}
                  {book.pendingWork && (
                    <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
                      {t('book.resume.reason', { reason: book.pendingWork.reason || t('common.unknown') })}
                    </p>
                  )}
                </div>

                {book.processed && (
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {book.processed.counts.skip > 0 && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                        {t('library.badges.keep', { count: book.processed.counts.skip })}
                      </span>
                    )}
                    {book.processed.counts.digest > 0 && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                        {t('library.badges.digest', { count: book.processed.counts.digest })}
                      </span>
                    )}
                    {book.processed.counts.drop > 0 && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                        {t('library.badges.drop', { count: book.processed.counts.drop })}
                      </span>
                    )}
                  </div>
                )}

                <div className="mt-auto flex flex-wrap items-center gap-2">
                  <Link
                    href={`/dashboard/library/${book.bookId}`}
                    className="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
                  >
                    {t('library.open')}
                  </Link>
                  {book.latestExport && (
                    <a
                      href={booksApi.exportDownloadUrl(book.bookId, book.latestExport.name)}
                      className="rounded-md border border-gray-200 px-3 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                    >
                      {t('library.export')}
                    </a>
                  )}
                  <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
                    {book.exportCount
                      ? `${t('library.exportsTitle')}: ${book.exportCount}`
                      : t('library.noExports')}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
