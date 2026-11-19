'use client';

import { FormEvent, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import { routing, type Locale } from '@/i18n/routing';
import { authClient } from '@/lib/auth-client';
import { SocialSignIn } from '@/components/auth/social-sign-in';
import { TurnstileWidget } from '@/components/auth/turnstile-widget';
import type { SocialProvider } from '@/lib/auth/social';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeSwitcher } from '@/components/theme-switcher';

export function Login({
  mode,
  requiresTurnstile,
  turnstileReady,
  siteKey,
  passwordResetAvailable = false,
  socialProviders = [],
  socialError,
}: {
  mode: 'signin' | 'signup';
  requiresTurnstile: boolean;
  turnstileReady: boolean;
  siteKey: string;
  passwordResetAvailable?: boolean;
  /** Providers this deployment has keys for; empty hides the whole block. */
  socialProviders?: SocialProvider[];
  /** `?error=` from a failed provider callback, mapped to a sentence. */
  socialError?: string;
}) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('Login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // 默认勾上：用户要求注册时替用户先勾好，不用再手动点一下。取消勾选照旧有效，
  // 所以"可选"这件事没变，只是默认值反了过来。
  const [marketingOptInRequested, setMarketingOptInRequested] = useState(true);
  const [token, setToken] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // Sign-up runs in two steps: the first mails a code, the second spends it.
  // The password never leaves this component until step two, so an abandoned
  // sign-up leaves nothing behind but an unverified row that cannot sign in.
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [code, setCode] = useState('');

  function sendErrorText(reason?: string) {
    if (reason === 'email_taken') return t('errorEmailTaken');
    if (reason === 'invalid_email') return t('errorInvalidEmail');
    if (reason === 'invalid_password') return t('errorInvalidPassword');
    return t('errorSendFailed');
  }

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || (requiresTurnstile && (!turnstileReady || !token))) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/registration/send-code', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(requiresTurnstile ? { 'x-captcha-response': token } : {}),
        },
        body: JSON.stringify({
          name: name.trim(), email, password,
          // The profile fields the old one-shot sign-up used to carry. Step two
          // only sends the code back, so anything missing here is simply lost.
          marketingOptInRequested,
          preferredLocale: routing.locales.includes(locale as Locale) ? locale : 'en',
          localeSource: 'site_locale',
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(sendErrorText(body.error));
        return;
      }
      setStep('code');
      setCode('');
    } catch {
      setError(t('error'));
    } finally {
      setPending(false);
      if (requiresTurnstile) setResetKey((value) => value + 1);
    }
  }

  async function confirmCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || code.trim().length === 0) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/registration/verify-code', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: code.trim() }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error === 'not_registered' ? t('errorEmailTaken') : t('errorInvalidCode'));
        return;
      }
      // The claim is durable in PostgreSQL; a dashboard visit retries it if
      // this request fails after the mailbox is confirmed.
      try {
        await fetch('/api/referrals/claim', { method: 'POST', credentials: 'same-origin' });
      } catch { /* registration still succeeds */ }
      router.push('/dashboard');
      router.refresh();
    } catch {
      setError(t('error'));
    } finally {
      setPending(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === 'signup') {
      await (step === 'form' ? sendCode(event) : confirmCode(event));
      return;
    }
    if (pending || (requiresTurnstile && (!turnstileReady || !token))) return;
    setPending(true);
    setError('');
    try {
      const fetchOptions = requiresTurnstile
        ? { headers: { 'x-captcha-response': token } }
        : undefined;
      const result = await authClient.signIn.email({ email, password, fetchOptions });
      if (result.error) {
        setError(result.error.message || t('error'));
        return;
      }
      router.push('/dashboard');
      router.refresh();
    } catch {
      setError(t('error'));
    } finally {
      setPending(false);
      if (requiresTurnstile) setResetKey((value) => value + 1);
    }
  }

  const awaitingCode = mode === 'signup' && step === 'code';
  const submitDisabled = pending || (
    awaitingCode
      ? code.trim().length === 0
      : requiresTurnstile && (!turnstileReady || !token)
  );

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-16 text-gray-900 dark:bg-gray-950 dark:text-white">
      <div className="mx-auto max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-5 flex justify-end gap-2"><LanguageSwitcher /><ThemeSwitcher /></div>
        <h1 className="text-2xl font-semibold">
          {mode === 'signin' ? t('signInTitle') : t('signUpTitle')}
        </h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {awaitingCode ? t('codeHelp') : t('description')}
        </p>
        <form onSubmit={submit} className="mt-8 space-y-5">
          {awaitingCode && (
            <>
              {/* The code just went out; say so plainly and name the junk
                  folder, because a first message from a young domain lands
                  there more often than not. */}
              <p role="status" className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100">
                {t('codeSent')}
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t('email')}: <span className="font-medium text-gray-900 dark:text-white">{email}</span>
              </p>
              <label className="block text-sm font-medium">
                {t('codeLabel')}
                <input
                  className="mt-2 w-full rounded-lg border p-3 text-center text-2xl tracking-[0.4em] dark:border-gray-600 dark:bg-gray-800"
                  inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
              </label>
            </>
          )}
          {!awaitingCode && mode === 'signup' && (
            <label className="block text-sm font-medium">
              {t('name')}
              <input id="signup-name" aria-describedby="signup-name-help"
                className="mt-2 w-full rounded-lg border p-3 dark:border-gray-600 dark:bg-gray-800" value={name}
                onChange={(event) => setName(event.target.value)} maxLength={100} autoComplete="name" />
              {/* The field is a display name: it is not unique and it cannot sign
                  anyone in, so the label alone must not promise either. */}
              <span id="signup-name-help" className="mt-1 block text-xs font-normal text-gray-500 dark:text-gray-400">
                {t('nameHelp')}
              </span>
            </label>
          )}
          {!awaitingCode && (
            <>
              <label className="block text-sm font-medium">
                {t('email')}
                <input className="mt-2 w-full rounded-lg border p-3 dark:border-gray-600 dark:bg-gray-800" type="email" required
                  value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
              </label>
              <label className="block text-sm font-medium">
                {t('password')}
                <input className="mt-2 w-full rounded-lg border p-3 dark:border-gray-600 dark:bg-gray-800" type="password" required minLength={8}
                  value={password} onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
              </label>
            </>
          )}
          {!awaitingCode && mode === 'signup' && (
            <label className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-200">
              <input type="checkbox" className="mt-1" checked={marketingOptInRequested}
                onChange={(event) => setMarketingOptInRequested(event.target.checked)} />
              <span>{t('marketingOptIn')}</span>
            </label>
          )}
          {/* The human check guards the mailing step only: once a code has gone
              out, re-solving it would protect nothing the code does not. */}
          {!awaitingCode && requiresTurnstile && turnstileReady && (
            <TurnstileWidget siteKey={siteKey} onToken={setToken} resetKey={resetKey} />
          )}
          {!awaitingCode && requiresTurnstile && !turnstileReady && (
            <p role="alert" className="text-sm text-red-700">{t('humanUnavailable')}</p>
          )}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <button className="w-full rounded-lg bg-gray-900 px-4 py-3 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-gray-950"
            type="submit" disabled={submitDisabled}>
            {pending ? t('pending')
              : awaitingCode ? t('verifyAndCreate')
                : mode === 'signin' ? t('signIn') : t('sendCode')}
          </button>
          {awaitingCode && (
            <button className="w-full rounded-lg border px-4 py-3 text-sm font-medium dark:border-gray-600"
              type="button" onClick={() => { setStep('form'); setCode(''); setError(''); }}>
              {t('editDetails')}
            </button>
          )}
        </form>
        {/* Below the form, the way GitHub's own sign-in page orders it. Hidden
            while a sign-up waits on its mailed code: the provider would sign the
            reader in and abandon the account being built. */}
        {!awaitingCode && <SocialSignIn providers={socialProviders} error={socialError} />}
        {mode === 'signin' && (
          <p className="mt-4 text-center text-sm text-gray-600 dark:text-gray-300">
            {passwordResetAvailable
              ? <Link className="underline" href="/forgot-password">{t('forgotPassword')}</Link>
              : t('passwordResetUnavailable')}
          </p>
        )}
        <p className="mt-6 text-center text-sm text-gray-600 dark:text-gray-300">
          {mode === 'signin' ? t('newHere') : t('alreadyHaveAccount')}{' '}
          <Link className="font-medium text-gray-900 underline dark:text-white"
            href={mode === 'signin' ? '/sign-up' : '/sign-in'}>
            {mode === 'signin' ? t('createAccount') : t('signIn')}
          </Link>
        </p>
      </div>
    </main>
  );
}
