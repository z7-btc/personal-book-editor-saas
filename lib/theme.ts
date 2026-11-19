/**
 * The theme choice is the one piece of interface state the server has to know
 * before the first paint: it is rendered onto `<html>`, so the browser never
 * shows the wrong theme while the JavaScript is still loading.
 *
 * It travels in a cookie rather than in `localStorage` for exactly that reason
 * — the server can read a cookie and cannot read `localStorage` — and the value
 * stays one of three words, so nothing here ever parses a payload.
 */

export const THEME_COOKIE = 'theme';

export const THEME_CHOICES = ['light', 'dark', 'system'] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** A year: long enough to still be there tomorrow, short enough to expire. */
export const THEME_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * Anything that is not an explicit choice means "follow the operating system",
 * including a value written by an older build. An unrecognised value must never
 * leave the page unthemed, so it degrades to `system` rather than to nothing.
 */
export function readThemeChoice(value: string | null | undefined): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * The class the server puts on `<html>`. `system` adds none: the
 * `prefers-color-scheme` rules in `app/globals.css` answer for it, which is
 * what lets the operating system decide without a script.
 */
export function themeClassFor(choice: ThemeChoice): string {
  return choice === 'system' ? '' : choice;
}

/**
 * `system` deletes the cookie instead of storing a third value: "no choice" is
 * the absence of the cookie, which is what the server checks. `samesite=lax` is
 * enough because nothing but this site ever needs to send it.
 */
export function themeCookieValue(choice: ThemeChoice): string {
  const maxAge = choice === 'system' ? 0 : THEME_COOKIE_MAX_AGE_SECONDS;
  return `${THEME_COOKIE}=${choice}; path=/; max-age=${maxAge}; samesite=lax`;
}

/**
 * Reads the choice out of a `document.cookie` string. The server uses
 * `cookies().get()` instead, which has already done this splitting.
 */
export function readThemeFromCookieHeader(cookieHeader: string | null | undefined): ThemeChoice {
  if (!cookieHeader) return 'system';
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === THEME_COOKIE) {
      return readThemeChoice(part.slice(separator + 1).trim());
    }
  }
  return 'system';
}
