'use client';

import { useSyncExternalStore } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, ChevronDown, Languages } from 'lucide-react';
import { usePathname, useRouter } from '@/i18n/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Each option is written in its own language on purpose: someone who cannot
// read the current interface language still needs to find their own.
export const LOCALES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
] as const;

/** The language lives in the URL, so this store never changes. */
function release(): void {
  // Nothing to unsubscribe: no source can push a new value.
}

function subscribe(): () => void {
  return release;
}

function hydratedSnapshot(): boolean {
  return true;
}

function neverHydrated(): boolean {
  return false;
}

export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations('Nav');
  const pathname = usePathname();
  const router = useRouter();
  // The menu cannot answer before React owns it: a choice made in that window
  // would be discarded when the page finishes hydrating, so the control stays
  // disabled until the browser is listening.
  const hydrated = useSyncExternalStore(subscribe, hydratedSnapshot, neverHydrated);
  const current = LOCALES.find((option) => option.value === locale) ?? LOCALES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('language')}
        disabled={!hydrated}
        className="group inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm transition-all duration-200 hover:border-gray-400 hover:bg-gray-50 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60 motion-reduce:transition-none dark:border-gray-600 dark:bg-gray-900 dark:hover:border-gray-500 dark:hover:bg-gray-800"
      >
        <Languages className="h-4 w-4 transition-transform duration-200 group-hover:scale-110 motion-reduce:transition-none" aria-hidden="true" />
        {current.label}
        <ChevronDown
          className="h-3.5 w-3.5 opacity-60 transition-transform duration-200 group-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[9rem] rounded-lg border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
      >
        {LOCALES.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onSelect={() => router.replace(
              `${pathname}${window.location.search}${window.location.hash}`,
              { locale: option.value }
            )}
            className="cursor-pointer rounded-md px-2.5 py-2 text-sm transition-colors duration-150 focus:bg-gray-100 data-[highlighted]:bg-gray-100 dark:focus:bg-gray-800 dark:data-[highlighted]:bg-gray-800"
          >
            {option.label}
            {option.value === locale && <Check className="ml-auto h-4 w-4" aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
