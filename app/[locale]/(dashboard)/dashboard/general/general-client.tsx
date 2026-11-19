'use client';

import { FormEvent, useState } from 'react';
import { useTranslations } from 'next-intl';
import { authClient } from '@/lib/auth-client';
import { Link } from '@/i18n/navigation';
import { routing, type Locale } from '@/i18n/routing';

export default function GeneralClient({ emailConfirmationAvailable }: {
  emailConfirmationAvailable: boolean;
}) {
  const t = useTranslations('General');
  const { data: session, isPending, refetch } = authClient.useSession();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [verificationPending, setVerificationPending] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const [emailChangePending, setEmailChangePending] = useState(false);
  const [emailChangeSent, setEmailChangeSent] = useState(false);
  const [signInRequired, setSignInRequired] = useState(false);

  async function requestEmailConfirmation() {
    if (!session?.user.email || verificationPending || verificationSent) return;
    setVerificationPending(true);
    setMessage('');
    try {
      const result = await authClient.sendVerificationEmail({
        email: session.user.email,
        callbackURL: '/dashboard/general',
      });
      if (result.error) setMessage(t('confirmationFailed'));
      else {
        setVerificationSent(true);
        setMessage(t('confirmationSent'));
      }
    } catch {
      setMessage(t('confirmationFailed'));
    } finally {
      setVerificationPending(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextName = String(form.get('name') || '').trim();
    const requestedLocale = String(form.get('preferredLocale') || '');
    const preferredLocale = routing.locales.includes(requestedLocale as Locale)
      ? (requestedLocale as Locale)
      : 'en';
    if (!nextName || !session || pending) return;
    setPending(true);
    setMessage('');
    try {
      const result = await authClient.updateUser({
        name: nextName, preferredLocale, localeSource: 'user_selected',
        marketingOptInRequested: form.get('marketingOptInRequested') === 'on',
      });
      if (result.error) setMessage(t('saveFailed'));
      else {
        setMessage(t('saved'));
        await refetch();
      }
    } catch {
      setMessage(t('saveFailed'));
    } finally {
      setPending(false);
    }
  }

  async function changeEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || emailChangePending || emailChangeSent) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setEmailChangePending(true);
    setSignInRequired(false);
    setMessage('');
    try {
      const result = await authClient.$fetch('/account/request-email-change', {
        method: 'POST',
        body: { newEmail: String(data.get('newEmail') || '').trim(), password: String(data.get('password') || '') },
      });
      if (result.error) {
        const code = (result.error as { code?: string }).code;
        if (code === 'SESSION_NOT_FRESH' || code === 'UNAUTHORIZED') {
          setSignInRequired(true);
          setMessage(t('emailChangeSignIn'));
        } else if (code === 'INVALID_PASSWORD') setMessage(t('emailChangePasswordInvalid'));
        else if (result.error.status === 429) setMessage(t('emailChangeRateLimited'));
        else setMessage(t('emailChangeFailed'));
      } else {
        setEmailChangeSent(true);
        form.reset();
        setMessage(t('emailChangeSent'));
      }
    } catch {
      setMessage(t('emailChangeFailed'));
    } finally {
      // Avoid retaining the current password in the form after any attempt.
      const password = form.elements.namedItem('password');
      if (password instanceof HTMLInputElement) password.value = '';
      setEmailChangePending(false);
    }
  }

  return (
    <section className="max-w-2xl rounded-xl border bg-white p-8 dark:border-gray-700 dark:bg-gray-900">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-3 text-gray-600 dark:text-gray-300">{t('email', { email: session?.user.email || t('loading') })}</p>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
        {t('emailOwnership', { status: session?.user.emailVerified ? t('confirmed') : t('unconfirmed') })}
      </p>
      <form key={session ? `${session.user.id}:${session.user.name}:${session.user.preferredLocale}:${session.user.marketingOptInRequested}` : 'loading'}
        onSubmit={save} className="mt-8 space-y-4">
        <fieldset disabled={isPending || !session || pending} className="space-y-4 disabled:opacity-50">
        <label className="block text-sm font-medium">
          {t('displayName')}
          <input className="mt-2 w-full rounded-lg border p-3 dark:border-gray-600 dark:bg-gray-800"
            name="name" defaultValue={session?.user.name || ''}
            maxLength={100} required />
        </label>
        <label className="block text-sm font-medium">
          {t('emailLanguage')}
          <select name="preferredLocale" defaultValue={session?.user.preferredLocale || 'en'}
            className="mt-2 min-h-11 w-full rounded-lg border p-3 dark:border-gray-600 dark:bg-gray-800">
            <option value="zh-CN">{t('chinese')}</option>
            <option value="en">{t('english')}</option>
            <option value="ja">{t('japanese')}</option>
            <option value="de">{t('german')}</option>
            <option value="es">{t('spanish')}</option>
            <option value="fr">{t('french')}</option>
          </select>
        </label>
        <div>
          <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
            <input type="checkbox" name="marketingOptInRequested"
              defaultChecked={Boolean(session?.user.marketingOptInRequested)}
              aria-describedby="marketing-preference-help" className="h-5 w-5" />
            {t('marketingOptIn')}
          </label>
          <p id="marketing-preference-help" className="text-sm text-gray-600 dark:text-gray-300">{t('marketingHelp')}</p>
        </div>
        <button type="submit" className="min-h-11 rounded-lg bg-gray-900 px-5 py-2 text-white disabled:opacity-50 dark:bg-white dark:text-gray-950">
          {pending ? t('saving') : t('saveName')}
        </button>
        </fieldset>
      </form>
      {message && <p role="status" aria-live="polite" className="mt-4 text-sm">{message}</p>}
      {signInRequired && <Link href="/sign-in" className="mt-3 inline-flex min-h-11 items-center underline">{t('signInAgain')}</Link>}
      {!session?.user.emailVerified && !emailConfirmationAvailable && (
        <p className="mt-8 rounded-lg bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {t('confirmationUnavailable')}
        </p>
      )}
      {!session?.user.emailVerified && emailConfirmationAvailable && (
        <button type="button" onClick={requestEmailConfirmation}
          disabled={verificationPending || verificationSent || !session?.user.email}
          className="mt-6 min-h-11 rounded-lg border px-5 py-2 text-sm disabled:opacity-50 dark:border-gray-600">
          {verificationPending ? t('confirmationSending') : t('sendConfirmation')}
        </button>
      )}
      {!session?.user.emailVerified && verificationSent && (
        <button type="button" onClick={() => { setVerificationSent(false); setMessage(''); }}
          className="mt-3 min-h-11 rounded-lg border px-5 py-2 text-sm dark:border-gray-600">
          {t('tryAgain')}
        </button>
      )}
      <div className="mt-8 border-t pt-8 dark:border-gray-700">
        <h2 className="text-lg font-semibold">{t('changeEmail')}</h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{t('emailChangeHelp')}</p>
        {!emailConfirmationAvailable ? (
          <p className="mt-3 text-sm text-amber-800 dark:text-amber-200">{t('confirmationUnavailable')}</p>
        ) : !session?.user.emailVerified ? (
          <p className="mt-3 text-sm text-amber-800 dark:text-amber-200">{t('emailChangeConfirmFirst')}</p>
        ) : (
          <form onSubmit={changeEmail} className="mt-4 space-y-4">
            <fieldset disabled={emailChangePending || emailChangeSent} className="space-y-4 disabled:opacity-50">
              <label className="block text-sm font-medium">
                {t('newEmail')}
                <input name="newEmail" type="email" autoComplete="email" maxLength={254} required
                  className="mt-2 w-full rounded-lg border p-3 dark:border-gray-600 dark:bg-gray-800" />
              </label>
              <label className="block text-sm font-medium">
                {t('currentPassword')}
                <input name="password" type="password" autoComplete="current-password" maxLength={128} required
                  className="mt-2 w-full rounded-lg border p-3 dark:border-gray-600 dark:bg-gray-800" />
              </label>
              <button type="submit" className="min-h-11 rounded-lg border px-5 py-2 text-sm dark:border-gray-600">
                {emailChangePending ? t('confirmationSending') : t('requestEmailChange')}
              </button>
            </fieldset>
          </form>
        )}
        {emailChangeSent && (
          <button type="button" onClick={() => { setEmailChangeSent(false); setMessage(''); }}
            className="mt-3 min-h-11 rounded-lg border px-5 py-2 text-sm dark:border-gray-600">
            {t('tryAgain')}
          </button>
        )}
      </div>
    </section>
  );
}
