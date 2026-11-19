'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, Monitor, Moon, Sun } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  THEME_CHOICES,
  readThemeFromCookieHeader,
  themeClassFor,
  themeCookieValue,
  type ThemeChoice,
} from '@/lib/theme';

const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

/**
 * The choice lives in a cookie so the server can render it onto `<html>`, which
 * means this component owns the only copy the browser keeps in memory. A cookie
 * is not reactive, so the switcher notifies its own subscribers after writing
 * one; nothing else ever changes the value.
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ThemeChoice {
  return readThemeFromCookieHeader(document.cookie);
}

/** The server rendered no theme class, so "system" is the honest first answer. */
function getServerSnapshot(): ThemeChoice {
  return 'system';
}

/**
 * A server-rendered control cannot answer before React owns it: a choice made
 * in that window would be discarded and the visitor would see the menu snap
 * back with nothing else happening. The two snapshots differ by construction,
 * which is what makes this the hydration-safe way to say "the browser is
 * listening now".
 */
function hydratedSnapshot(): boolean {
  return true;
}

function neverHydrated(): boolean {
  return false;
}

/**
 * Written outside the component so it reads as the event-time side effect it
 * is, not as work that might run while rendering.
 */
function applyThemeChoice(next: ThemeChoice) {
  document.cookie = themeCookieValue(next);
  // The class is applied here rather than by a re-render: `<html>` belongs to
  // the server layout, and a switch that waited for a navigation would leave
  // the page in the previous theme until then. A `system` choice removes both
  // classes so the media query takes over again.
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  const className = themeClassFor(next);
  if (className) root.classList.add(className);
  for (const listener of listeners) listener();
}

export function ThemeSwitcher() {
  const t = useTranslations('Nav');
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const hydrated = useSyncExternalStore(subscribe, hydratedSnapshot, neverHydrated);

  // The mark follows the current choice, so the control says what it is doing
  // without the visitor having to read the label.
  const ThemeIcon = THEME_ICONS[choice];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('theme')}
        disabled={!hydrated}
        className="group inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm transition-all duration-200 hover:border-gray-400 hover:bg-gray-50 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60 motion-reduce:transition-none dark:border-gray-600 dark:bg-gray-900 dark:hover:border-gray-500 dark:hover:bg-gray-800"
      >
        <ThemeIcon className="h-4 w-4 transition-transform duration-200 group-hover:scale-110 motion-reduce:transition-none" aria-hidden="true" />
        {t(choice)}
        <ChevronDown
          className="h-3.5 w-3.5 opacity-60 transition-transform duration-200 group-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[9rem] rounded-lg border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
      >
        {THEME_CHOICES.map((option) => {
          const OptionIcon = THEME_ICONS[option];
          return (
            <DropdownMenuItem
              key={option}
              onSelect={() => applyThemeChoice(option)}
              className="cursor-pointer rounded-md px-2.5 py-2 text-sm transition-colors duration-150 focus:bg-gray-100 data-[highlighted]:bg-gray-100 dark:focus:bg-gray-800 dark:data-[highlighted]:bg-gray-800"
            >
              <OptionIcon className="h-4 w-4" aria-hidden="true" />
              {t(option)}
              {choice === option && <Check className="ml-auto h-4 w-4" aria-hidden="true" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
