'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, Sparkles } from 'lucide-react';
import { parseProfilePaste, type ParsedProfile, type ProfileField } from '@/lib/profile-import';

/**
 * 阅读画像页顶部的「让 AI 帮你填」。
 *
 * 常被用户使用的 AI（ChatGPT、Gemini……）比用户自己更清楚他的背景和偏好，
 * 所以这里给一段提示词，让 AI 按固定小标题输出，再把回答整段粘回来。
 * 解析在浏览器本地完成：不花额度、不用等模型，粘贴完当场就能导入。
 */
export default function ProfileImportCard({ labels, onImport }: {
  labels: Partial<Record<ProfileField, string>>;
  /** 返回实际导入并保存的字段数；抛错表示保存失败。 */
  onImport: (parsed: ParsedProfile) => Promise<number>;
}) {
  const t = useTranslations('Books.profileImport');
  const prompt = t('prompt');
  const [copied, setCopied] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [paste, setPaste] = useState('');
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 没有剪贴板权限时，提示词本身可选中，用户仍能手动复制；
      // 这里不谎报「已复制」。
    }
  }

  async function importPaste() {
    if (importing) return;
    setStatus(null);
    const parsed = parseProfilePaste(paste, labels);
    if (!Object.keys(parsed).length) {
      setStatus({ kind: 'error', text: t('nothingFound') });
      return;
    }
    setImporting(true);
    try {
      const count = await onImport(parsed);
      if (count === 0) {
        setStatus({ kind: 'error', text: t('nothingFound') });
      } else {
        setStatus({ kind: 'ok', text: t('importedCount', { count }) });
        setPaste('');
      }
    } catch {
      setStatus({ kind: 'error', text: t('saveFailed') });
    } finally {
      setImporting(false);
    }
  }

  return <section className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-5 dark:border-emerald-900 dark:bg-emerald-950/20">
    <div className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950">
        <Sparkles aria-hidden="true" className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{t('title')}</h2>
        <p className="mt-1 max-w-3xl text-sm text-gray-700 dark:text-gray-300">{t('subtitle')}</p>
      </div>
    </div>

    <ol className="mt-4 space-y-1.5 text-sm text-gray-700 dark:text-gray-300">
      <li className="flex gap-2"><span className="font-medium text-emerald-700 dark:text-emerald-400">1.</span>{t('step1')}</li>
      <li className="flex gap-2"><span className="font-medium text-emerald-700 dark:text-emerald-400">2.</span>{t('step2')}</li>
      <li className="flex gap-2"><span className="font-medium text-emerald-700 dark:text-emerald-400">3.</span>{t('step3')}</li>
    </ol>

    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{t('promptLabel')}</span>
        <button
          type="button"
          onClick={() => void copyPrompt()}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-3 text-xs font-medium text-emerald-800 transition-colors hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:border-emerald-800 dark:bg-gray-900 dark:text-emerald-300 dark:hover:bg-emerald-950"
        >
          {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
          {copied ? t('copied') : t('copy')}
        </button>
      </div>
      <pre className={`mt-2 overflow-auto whitespace-pre-wrap rounded-lg border border-emerald-200 bg-white p-3 font-sans text-xs leading-relaxed text-gray-700 select-all dark:border-emerald-900 dark:bg-gray-950 dark:text-gray-300 ${promptExpanded ? '' : 'max-h-56'}`}>{prompt}</pre>
      <button
        type="button"
        onClick={() => setPromptExpanded((open) => !open)}
        aria-expanded={promptExpanded}
        className="mt-1.5 text-xs font-medium text-emerald-800 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:text-emerald-300"
      >
        {promptExpanded ? t('collapsePrompt') : t('expandPrompt')}
      </button>
    </div>

    <div className="mt-4 space-y-2">
      <label className="block space-y-1">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{t('pasteLabel')}</span>
        <textarea
          value={paste}
          onChange={(event) => setPaste(event.target.value)}
          rows={5}
          placeholder={t('pastePlaceholder')}
          className="w-full rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500 dark:border-emerald-900 dark:bg-gray-950 dark:focus:border-emerald-500"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void importPaste()}
          disabled={importing || !paste.trim()}
          className="rounded-md bg-emerald-700 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-800 disabled:opacity-50 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
        >
          {importing ? t('importing') : t('importButton')}
        </button>
        <span aria-live="polite" className={`text-sm ${status?.kind === 'error' ? 'text-red-700 dark:text-red-400' : 'text-emerald-800 dark:text-emerald-300'}`}>
          {status?.text ?? ''}
        </span>
      </div>
    </div>
  </section>;
}
