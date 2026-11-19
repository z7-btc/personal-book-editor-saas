'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * 邀请码 / 邀请链接的展示框，右侧一颗复制按钮。
 *
 * 值本身是**可选中**的普通文本：浏览器不给剪贴板权限时（非 HTTPS、无授权），
 * 用户还能手动选中复制。那种情况下按钮保持原样，不弹一句假的「已复制」。
 */
export default function CopyField({ label, value, size = 'normal' }: {
  label: string;
  value: string;
  /** 邀请码可以放大加粗；链接太长，保持小号等宽。 */
  size?: 'normal' | 'large';
}) {
  const t = useTranslations('Referrals');
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      // 两秒后自己复位，不然「已复制」会一直挂着，看着像按钮变成了状态。
      window.setTimeout(() => setCopied(false), 2000);
    } catch { /* 保留可选中文本这条路，不谎报成功。 */ }
  }

  return <div className="space-y-2">
    <p className="text-xs font-medium tracking-wide text-gray-500 uppercase dark:text-gray-400">{label}</p>
    <div className="flex min-h-14 items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
      <span className={`min-w-0 select-all break-all ${size === 'large'
        ? 'font-mono text-xl font-semibold tracking-wider'
        : 'font-mono text-xs'}`}>{value}</span>
      <button type="button" onClick={() => void copy()}
        className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border border-gray-200 bg-white px-3 text-xs transition-colors hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:hover:text-white dark:focus-visible:outline-gray-300">
        {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5" />
          : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
        {copied ? t('copied') : t('copy')}
      </button>
    </div>
  </div>;
}
