import { describe, expect, it } from 'vitest';
import {
  THEME_CHOICES,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE_SECONDS,
  readThemeChoice,
  readThemeFromCookieHeader,
  themeClassFor,
  themeCookieValue,
} from '@/lib/theme';

/**
 * The theme choice is the one piece of interface state the server has to know
 * before the first paint, so these four functions are the whole contract
 * between the cookie, the class on `<html>` and the switcher. They are pure on
 * purpose: no React, no `document`, no `server-only`, so the same module can be
 * imported by the layout and by the client component that writes the cookie.
 */
describe('theme choice', () => {
  it('accepts exactly the two explicit choices and treats everything else as the system default', () => {
    expect(readThemeChoice('light')).toBe('light');
    expect(readThemeChoice('dark')).toBe('dark');
    expect(readThemeChoice('system')).toBe('system');

    // A value an older build or a hand-edited cookie could carry must never
    // leave the page unthemed, so it degrades to "follow the operating system"
    // rather than to nothing.
    for (const value of [undefined, null, '', 'Dark', 'dusk', 'true', '1']) {
      expect(readThemeChoice(value), `${String(value)} should not be an explicit choice`).toBe('system');
    }
  });

  it('puts a class on <html> only for an explicit choice', () => {
    expect(themeClassFor('dark')).toBe('dark');
    expect(themeClassFor('light')).toBe('light');
    // `system` is the absence of a class: the media query in globals.css answers
    // for it, which is what removes the need for a script.
    expect(themeClassFor('system')).toBe('');
  });

  it('writes a first-party cookie that expires when the visitor returns to the system default', () => {
    expect(themeCookieValue('dark')).toBe(
      `${THEME_COOKIE}=dark; path=/; max-age=${THEME_COOKIE_MAX_AGE_SECONDS}; samesite=lax`,
    );
    expect(themeCookieValue('light')).toContain('theme=light');
    // "No choice" is the absence of the cookie, not a third stored value.
    expect(themeCookieValue('system')).toContain('max-age=0');
  });

  it('reads the choice back out of a document.cookie string', () => {
    expect(readThemeFromCookieHeader(`theme=dark`)).toBe('dark');
    expect(readThemeFromCookieHeader(`a=1; theme=light; b=2`)).toBe('light');
    expect(readThemeFromCookieHeader(`theme=dark; theme=light`)).toBe('dark');
    expect(readThemeFromCookieHeader('a=1; b=2')).toBe('system');
    expect(readThemeFromCookieHeader('')).toBe('system');
    expect(readThemeFromCookieHeader(undefined)).toBe('system');

    // A different cookie whose name merely starts with the same letters must
    // not be mistaken for the theme.
    expect(readThemeFromCookieHeader('theme_choice=dark')).toBe('system');
    expect(readThemeFromCookieHeader('theme=dark; other=1')).toBe('dark');
  });

  it('round-trips what it writes, so the switcher and the server agree', () => {
    for (const choice of THEME_CHOICES) {
      expect(readThemeFromCookieHeader(themeCookieValue(choice))).toBe(choice);
    }
  });
});
