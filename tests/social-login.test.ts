import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * Google and GitHub sign-in.
 *
 * The login surface cannot be rendered under Vitest — `tests/referral-ui.test.ts`
 * explains why this repository pins UI contracts over real rendered sources
 * instead of a DOM. What is worth pinning here:
 *
 *  1. the `?error=` code the provider callback redirects with decides which
 *     sentence a user reads, and an unrecognised code must still produce a
 *     sentence rather than an empty alert;
 *  2. the buttons render only for a capability that reports `configured`, so a
 *     missing key degrades to the password-only page instead of a dead button;
 *  3. every message key the component references exists in both catalogs.
 */

const require_ = createRequire(import.meta.url);
const { readFileSync } = require_('node:fs') as {
  readFileSync: (path: URL, encoding: 'utf8') => string;
};
const file = (relative: string) => new URL(relative, import.meta.url);
const source = (relative: string) => readFileSync(file(relative), 'utf8');

const COMPONENT = '../components/auth/social-sign-in.tsx';
const LOGIN = '../app/[locale]/(login)/login.tsx';
const SIGN_IN_PAGE = '../app/[locale]/(login)/sign-in/page.tsx';
const SIGN_UP_PAGE = '../app/[locale]/(login)/sign-up/page.tsx';
const AUTH = '../lib/auth.ts';
const ENV_EXAMPLE = '../.env.example';

const CATALOGS = {
  en: (require_('../messages/en.json') as { Login: Record<string, string> }).Login,
  'zh-CN': (require_('../messages/zh-CN.json') as { Login: Record<string, string> }).Login,
};

/** Every code Better Auth can put on the `errorCallbackURL` redirect. */
const ERROR_CODES = [
  'email_not_verified',
  'email_not_found',
  'email_does_not_match',
  'account_already_linked_to_different_user',
  'unable_to_link_account',
  'unable_to_get_user_info',
  'no_code',
  'invalid_state',
  'state_not_found',
  'access_denied',
  'a_code_this_test_has_never_seen',
] as const;

const SOCIAL_KEYS = [
  'socialGoogle',
  'socialGithub',
  'socialOr',
  'socialPending',
  'socialErrorEmailNotVerified',
  'socialErrorEmailNotFound',
  'socialErrorEmailMismatch',
  'socialErrorAccountTaken',
  'socialErrorLinkFailed',
  'socialErrorFlow',
  'socialErrorGeneric',
] as const;

const loadSocial = () => import('@/lib/auth/social');

describe('socialErrorMessageKey', () => {
  it('returns null when the callback reported no error', async () => {
    const { socialErrorMessageKey } = await loadSocial();
    expect(socialErrorMessageKey(undefined)).toBeNull();
    expect(socialErrorMessageKey('')).toBeNull();
  });

  it('maps a provider email the caller could not prove', async () => {
    const { socialErrorMessageKey } = await loadSocial();
    expect(socialErrorMessageKey('email_not_verified')).toBe('socialErrorEmailNotVerified');
    expect(socialErrorMessageKey('email_not_found')).toBe('socialErrorEmailNotFound');
  });

  it('maps the account-linking refusals', async () => {
    const { socialErrorMessageKey } = await loadSocial();
    expect(socialErrorMessageKey('email_does_not_match')).toBe('socialErrorEmailMismatch');
    expect(socialErrorMessageKey('account_already_linked_to_different_user')).toBe('socialErrorAccountTaken');
    expect(socialErrorMessageKey('unable_to_link_account')).toBe('socialErrorLinkFailed');
  });

  it('maps every interrupted-flow code to the retry sentence', async () => {
    const { socialErrorMessageKey } = await loadSocial();
    for (const code of ['unable_to_get_user_info', 'no_code', 'invalid_state', 'state_not_found']) {
      expect(socialErrorMessageKey(code), code).toBe('socialErrorFlow');
    }
  });

  it('still produces a sentence for a code it has never seen', async () => {
    const { socialErrorMessageKey } = await loadSocial();
    // A user pressing "cancel" at the provider comes back as `access_denied`.
    expect(socialErrorMessageKey('access_denied')).toBe('socialErrorGeneric');
    expect(socialErrorMessageKey('something_the_provider_added_later')).toBe('socialErrorGeneric');
  });
});

describe('social sign-in message keys', () => {
  it('exists in both catalogs', () => {
    for (const key of SOCIAL_KEYS) {
      expect(CATALOGS.en[key], `en.Login.${key}`).toBeTruthy();
      expect(CATALOGS['zh-CN'][key], `zh-CN.Login.${key}`).toBeTruthy();
    }
  });

  it('keeps the English side free of CJK', () => {
    const cjk = /[㐀-䶿一-鿿豈-﫿]/;
    for (const key of SOCIAL_KEYS) {
      const value = CATALOGS.en[key];
      // Without this, a missing key makes the CJK check vacuously true.
      expect(typeof value, `en.Login.${key}`).toBe('string');
      expect(cjk.test(value), `en.Login.${key} must not contain CJK`).toBe(false);
    }
  });

  it('gives the component and the mapping every sentence they can ask for', async () => {
    const { socialErrorMessageKey } = await loadSocial();
    // Every sentence the component names as a literal, plus every sentence the
    // mapping can return for a code the callback actually redirects with.
    const named = new Set<string>();
    for (const match of source(COMPONENT).matchAll(/'social[A-Za-z]+'/g)) {
      named.add(match[0].slice(1, -1));
    }
    for (const code of ERROR_CODES) {
      const key = socialErrorMessageKey(code);
      expect(key, code).not.toBeNull();
      named.add(key as string);
    }
    for (const key of named) {
      expect(CATALOGS.en[key], `en.Login.${key}`).toBeTruthy();
      expect(CATALOGS['zh-CN'][key], `zh-CN.Login.${key}`).toBeTruthy();
    }
    // The labels a reader meets on a working page must be among them.
    for (const key of ['socialGoogle', 'socialGithub', 'socialOr', 'socialPending']) {
      expect(named, `nothing names Login.${key}`).toContain(key);
    }
  });
});

describe('social provider wiring', () => {
  it('offers only the providers whose capability is configured', () => {
    for (const page of [SIGN_IN_PAGE, SIGN_UP_PAGE]) {
      const text = source(page);
      expect(text, page).toContain('googleOAuth.configured');
      expect(text, page).toContain('githubOAuth.configured');
      expect(text, page).toContain('socialProviders');
    }
  });

  it('hides the buttons and the divider together when nothing is configured', () => {
    expect(source(LOGIN)).toContain('SocialSignIn');
    const component = source(COMPONENT);
    // One early return covers the whole block, so an empty provider list cannot
    // leave an orphaned "or" above the password form.
    expect(component).toMatch(/providers\.length\s*===\s*0/);
    expect(component).toContain('return null');
    expect(component.indexOf('return null')).toBeLessThan(component.indexOf('socialOr'));
  });

  it('puts the provider buttons below the password form, the way GitHub does', () => {
    const login = source(LOGIN);
    const formEnd = login.indexOf('</form>');
    expect(formEnd, 'login.tsx has no closing </form>').toBeGreaterThan(-1);
    // Below the form, not above it: the password path is what most readers came
    // for, and they should not scroll past two buttons to reach it.
    expect(login.indexOf('<SocialSignIn'), LOGIN).toBeGreaterThan(formEnd);
  });

  it('draws the divider above the buttons it introduces', () => {
    const component = source(COMPONENT);
    // The block now sits under the password form, so "or" separates the form
    // from the buttons rather than the buttons from the form.
    expect(component.indexOf('socialOr')).toBeLessThan(component.indexOf('LABELS[provider]'));
  });

  it('draws each brand mark inside its own button, beside the label', () => {
    const component = source(COMPONENT);
    expect(component.indexOf('<ProviderIcon')).toBeGreaterThan(component.indexOf('<button'));
    expect(component.indexOf('<ProviderIcon')).toBeLessThan(component.indexOf('LABELS[provider]'));
  });

  it('has a mark for every provider the app can offer', async () => {
    const { SOCIAL_PROVIDERS } = await loadSocial();
    const { PROVIDER_ICONS } = await import('@/components/auth/provider-icons');
    // A provider added without a logo would ship a bare text button beside two
    // branded ones, so the map is keyed by the same union the buttons use.
    for (const provider of SOCIAL_PROVIDERS) {
      expect(typeof PROVIDER_ICONS[provider], provider).toBe('function');
    }
  });

  it('hides the buttons while a sign-up waits on its mailed code', () => {
    // A provider would sign the reader in and abandon the account the code was
    // about to create, so the block is gated on the same flag as the form.
    expect(source(LOGIN)).toMatch(/!awaitingCode\s*&&\s*<SocialSignIn/);
  });

  it('sends the callback back to a locale-prefixed dashboard', () => {
    const component = source(COMPONENT);
    expect(component).toContain('signIn.social');
    // `localePrefix: 'always'` — a bare /dashboard would be re-routed by the
    // middleware, which guesses the locale from Accept-Language.
    expect(component).toMatch(/`\/\$\{locale\}\/dashboard`/);
    expect(component).toMatch(/`\/\$\{locale\}\/sign-in`/);
    expect(component).toContain('errorCallbackURL');
  });

  it('catches a provider callback that arrives without its state', () => {
    const auth = source(AUTH);
    // `errorCallbackURL` rides inside the state, so it cannot help when the
    // state is the thing that is missing: an expired cookie, or a flow finished
    // in a browser on another device. Better Auth then falls back to
    // `onAPIError.errorURL`, and without one it serves its own English error
    // page inside a Chinese product. The value stays locale-neutral — the
    // middleware picks the language on the way in — so `/sign-in`, not a
    // prefixed path.
    expect(auth).toMatch(/onAPIError:\s*\{[^}]*errorURL:\s*'\/sign-in'/);
  });

  it('refuses a provider email the provider itself has not verified', () => {
    const auth = source(AUTH);
    expect(auth).toContain('socialProviders');
    // Without this, the user is created (emailVerified: false), then the session
    // gate in the same file rejects it and the browser stops on a raw error at
    // /api/auth/callback/<provider>.
    expect(auth.match(/requireEmailVerification:\s*true/g)?.length).toBe(2);
  });
});

describe('.env.example', () => {
  it('documents the two feature flags and their four keys', () => {
    const text = source(ENV_EXAMPLE);
    for (const name of [
      'FEATURE_GOOGLE_OAUTH',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'FEATURE_GITHUB_OAUTH',
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
    ]) {
      expect(text, name).toContain(name);
    }
  });
});
