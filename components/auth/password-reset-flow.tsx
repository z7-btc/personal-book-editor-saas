'use client';

import { FormEvent, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { authClient } from '@/lib/auth-client';
import { TurnstileWidget } from './turnstile-widget';
import { LanguageSwitcher } from '@/components/language-switcher';
import { ThemeSwitcher } from '@/components/theme-switcher';

type Props = {
  mode: 'request' | 'reset';
  available: boolean;
  requiresTurnstile?: boolean;
  turnstileReady?: boolean;
  siteKey?: string;
  resetToken?: string;
  invalidToken?: boolean;
};

export function PasswordResetFlow({ mode, available, requiresTurnstile = false,
  turnstileReady = false, siteKey = '', resetToken, invalidToken = false }: Props) {
  const t = useTranslations('PasswordReset');
  const locale = useLocale();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState('');
  const canSubmit = available && (mode === 'reset' ? Boolean(resetToken && !invalidToken)
    : !requiresTurnstile || (turnstileReady && Boolean(token)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !canSubmit) return;
    setPending(true);
    setError('');
    try {
      if (mode === 'request') {
        const result = await authClient.requestPasswordReset({
          email,
          redirectTo: `${window.location.origin}/${locale}/reset-password`,
          fetchOptions: requiresTurnstile ? { headers: { 'x-captcha-response': token } } : undefined,
        });
        if (result.error) setError(t('requestError'));
        else setCompleted(true);
      } else {
        const result = await authClient.resetPassword({ newPassword: password, token: resetToken! });
        if (result.error) setError(t('resetError'));
        else {
          window.history.replaceState(null, '', window.location.pathname);
          setCompleted(true);
          setPassword('');
        }
      }
    } catch {
      setError(mode === 'request' ? t('requestError') : t('resetError'));
    } finally {
      setPending(false);
      if (mode === 'request' && requiresTurnstile) setResetKey((value) => value + 1);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-16 text-gray-900 dark:bg-gray-950 dark:text-white">
      <div className="mx-auto max-w-md rounded-2xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-700 dark:bg-gray-900">
        <div className="mb-5 flex justify-end gap-2"><LanguageSwitcher /><ThemeSwitcher /></div>
        <h1 className="text-2xl font-semibold">{mode === 'request' ? t('requestTitle') : t('resetTitle')}</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {mode === 'request' ? t('requestDescription') : t('resetDescription')}
        </p>
        {!available && <p role="alert" className="mt-6 text-sm text-red-700">{t('unavailable')}</p>}
        {available && mode === 'reset' && (!resetToken || invalidToken) &&
          <p role="alert" className="mt-6 text-sm text-red-700">{t('invalidLink')}</p>}
        {completed && <p role="status" className="mt-6 text-sm text-green-700">
          {mode === 'request' ? t('requestComplete') : t('resetComplete')}
        </p>}
        {available && !completed && (mode === 'request' || Boolean(resetToken && !invalidToken)) && (
          <form onSubmit={submit} className="mt-8 space-y-5">
            {mode === 'request' ? (
              <label className="block text-sm font-medium">{t('email')}
                <input type="email" autoComplete="email" required value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="mt-2 w-full rounded-lg border p-3 dark:border-gray-600 dark:bg-gray-800" />
              </label>
            ) : (
              <label className="block text-sm font-medium">{t('newPassword')}
                <input type="password" autoComplete="new-password" minLength={8} maxLength={128}
                  required value={password} onChange={(event) => setPassword(event.target.value)}
                  className="mt-2 w-full rounded-lg border p-3 dark:border-gray-600 dark:bg-gray-800" />
              </label>
            )}
            {mode === 'request' && requiresTurnstile && turnstileReady &&
              <TurnstileWidget siteKey={siteKey} onToken={setToken} resetKey={resetKey} />}
            {mode === 'request' && requiresTurnstile && !turnstileReady &&
              <p role="alert" className="text-sm text-red-700">{t('humanUnavailable')}</p>}
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            <button type="submit" disabled={pending || !canSubmit}
              className="w-full rounded-lg bg-gray-900 px-4 py-3 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-gray-950">
              {pending ? t('pending') : mode === 'request' ? t('sendLink') : t('setPassword')}
            </button>
          </form>
        )}
        <p className="mt-6 text-center text-sm">
          <Link href="/sign-in" className="underline">{t('backToSignIn')}</Link>
        </p>
      </div>
    </main>
  );
}
