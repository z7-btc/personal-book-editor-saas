'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ApiError, booksApi, type PromptView } from './api';

type CardState = {
  content: string;
  full: boolean;
  loading: boolean;
  saving: boolean;
  message: string;
};

export default function PromptsClient() {
  const t = useTranslations('Books');
  const [prompts, setPrompts] = useState<PromptView[] | null>(null);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [error, setError] = useState('');

  const load = useCallback(
    async (full = false) => {
      try {
        const data = await booksApi.prompts(full);
        setPrompts(data.prompts);
        setCards((prev) => {
          const next: Record<string, CardState> = {};
          for (const prompt of data.prompts) {
            const existing = prev[prompt.file];
            const incoming = prompt.content ?? prompt.preview;
            // 已经加载过全文、而且用户没改过，就别拿预览覆盖掉。
            const keepFull = existing?.full && !existing.saving && !full;
            next[prompt.file] = {
              content: keepFull ? existing.content : incoming,
              full: keepFull || Boolean(prompt.content),
              loading: false,
              saving: false,
              message: '',
            };
          }
          return next;
        });
        setError('');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t('common.error'));
      }
    },
    [t],
  );

  useEffect(() => {
    void (async () => {
      await load(false);
    })();
  }, [load]);

  function edit(file: string, content: string) {
    setCards((prev) => ({
      ...prev,
      [file]: { ...prev[file], content, message: '' },
    }));
  }

  async function loadFull(file: string) {
    setCards((prev) => ({ ...prev, [file]: { ...prev[file], loading: true } }));
    try {
      const data = await booksApi.prompts(true);
      const target = data.prompts.find((item) => item.file === file);
      setCards((prev) => ({
        ...prev,
        [file]: {
          ...prev[file],
          loading: false,
          full: true,
          content: target?.content ?? prev[file]?.content ?? '',
        },
      }));
    } catch (err) {
      setCards((prev) => ({
        ...prev,
        [file]: {
          ...prev[file],
          loading: false,
          message: err instanceof ApiError ? err.message : t('common.error'),
        },
      }));
    }
  }

  async function save(file: string) {
    const card = cards[file];
    if (!card || card.saving) return;
    setCards((prev) => ({ ...prev, [file]: { ...prev[file], saving: true, message: '' } }));
    try {
      await booksApi.savePrompt(file, card.content);
      setCards((prev) => ({
        ...prev,
        [file]: { ...prev[file], saving: false, full: true, message: t('prompts.saved') },
      }));
    } catch (err) {
      setCards((prev) => ({
        ...prev,
        [file]: {
          ...prev[file],
          saving: false,
          message: err instanceof ApiError ? err.message : t('common.error'),
        },
      }));
    }
  }

  const input =
    'w-full rounded-md border border-gray-200 bg-transparent p-3 font-mono text-xs leading-relaxed outline-none focus:border-gray-400 dark:border-gray-700 dark:focus:border-gray-500';

  if (prompts === null) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>;
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t('prompts.title')}</h1>
        <p className="max-w-3xl text-sm text-gray-600 dark:text-gray-400">{t('prompts.subtitle')}</p>
      </header>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {prompts.map((prompt) => {
        const card = cards[prompt.file];
        if (!card) return null;
        const custom = prompt.source === 'user';
        return (
          <section
            key={prompt.file}
            className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-mono text-sm font-medium">{prompt.file}</h2>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] ${
                  custom
                    ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300'
                    : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                }`}
              >
                {custom ? t('prompts.sourceUser') : t('prompts.sourceBuiltin')}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {t('prompts.chars', { count: prompt.length })}
              </span>
            </div>

            {prompt.warning && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
                {t('prompts.warning')}: {prompt.warning}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="text-gray-500 dark:text-gray-400">{t('prompts.variables')}:</span>
              {prompt.variables.length === 0 ? (
                <span className="text-gray-400">{t('prompts.noVariables')}</span>
              ) : (
                prompt.variables.map((variable) => (
                  <code
                    key={variable}
                    className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                  >
                    {`{${variable}}`}
                  </code>
                ))
              )}
            </div>

            {card.content.trim() ? (
              <textarea
                value={card.content}
                onChange={(event) => edit(prompt.file, event.target.value)}
                rows={card.full ? 18 : 8}
                spellCheck={false}
                className={input}
                aria-label={prompt.file}
              />
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">{t('prompts.empty')}</p>
            )}

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => save(prompt.file)}
                disabled={card.saving}
                className="rounded-md bg-gray-900 px-3 py-1.5 font-medium text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
              >
                {card.saving ? t('common.saving') : t('prompts.save')}
              </button>
              {!card.full && (
                <button
                  type="button"
                  onClick={() => loadFull(prompt.file)}
                  disabled={card.loading}
                  className="rounded-md border border-gray-200 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800"
                >
                  {card.loading ? t('common.loading') : t('prompts.loadFull')}
                </button>
              )}
              <button
                type="button"
                onClick={() => load(true)}
                className="rounded-md border border-gray-200 px-3 py-1.5 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
              >
                {t('prompts.reload')}
              </button>
              {card.message && <span className="text-emerald-700 dark:text-emerald-400">{card.message}</span>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
