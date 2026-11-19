'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * 一条「默认收起、点一下展开」的横条。
 *
 * 关键不在于能不能点，而在于**看起来就知道能点**：标题加粗、整行悬停变色，
 * 右侧固定一颗带边框的「展开 ⌄」按钮，展开后变成「收起 ^」。只有一个小箭头
 * 的话，用户会以为那只是装饰（AutoTrading 那边就被这么说过）。
 *
 * 用 React 状态而不是原生 `<details>`：浏览器会替 `<details>` 记住甚至恢复
 * `open`，刷新后可能自己摊开，和"默认收起"矛盾。
 */
export default function CollapsibleSection({ title, hint, count, children }: {
  title: string;
  hint?: string;
  /** 右侧标题旁的小数字（比如渠道个数）；0 或不传就不画。 */
  count?: number;
  children: React.ReactNode;
}) {
  const t = useTranslations('Referrals');
  const [open, setOpen] = useState(false);
  return <div className="border-t border-gray-200 dark:border-gray-700">
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      className="group flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-600 dark:hover:bg-gray-800 dark:focus-visible:outline-gray-300"
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium">
          {title}
          {typeof count === 'number' && count > 0 &&
            <span className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-500 tabular-nums dark:border-gray-700 dark:text-gray-400">
              {count}
            </span>}
        </span>
        {hint && <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">{hint}</span>}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-gray-200 px-3 py-1 text-xs font-medium text-gray-500 transition-colors group-hover:border-gray-900 group-hover:text-gray-950 dark:border-gray-700 dark:text-gray-400 dark:group-hover:border-white dark:group-hover:text-white">
        {open ? t('collapse') : t('expand')}
        <ChevronDown aria-hidden="true"
          className={`h-3.5 w-3.5 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
      </span>
    </button>
    {open && <div className="border-t border-gray-200 px-4 py-4 dark:border-gray-700">{children}</div>}
  </div>;
}
