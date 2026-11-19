'use client';

import { FormEvent, useState } from 'react';
import { useTranslations } from 'next-intl';
import { authClient } from '@/lib/auth-client';

export default function SecurityPage() {
  const t = useTranslations('Security');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage('');
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) setMessage(result.error.message || t('failed'));
      else {
        setCurrentPassword('');
        setNewPassword('');
        setMessage(t('updated'));
      }
    } catch {
      setMessage(t('failed'));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="max-w-2xl rounded-xl border bg-white p-8 dark:border-gray-700 dark:bg-gray-900">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-3 text-gray-600 dark:text-gray-300">{t('description')}</p>
      <form onSubmit={changePassword} className="mt-8 space-y-4">
        <label className="block text-sm font-medium">{t('currentPassword')}
          <input className="mt-2 w-full rounded-lg border p-3 dark:border-gray-600 dark:bg-gray-800" type="password" required minLength={8}
            autoComplete="current-password" value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)} />
        </label>
        <label className="block text-sm font-medium">{t('newPassword')}
          <input className="mt-2 w-full rounded-lg border p-3 dark:border-gray-600 dark:bg-gray-800" type="password" required minLength={8}
            autoComplete="new-password" value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)} />
        </label>
        {message && <p role="status" className="text-sm">{message}</p>}
        <button type="submit" disabled={pending} className="rounded-lg bg-gray-900 px-5 py-2 text-white disabled:opacity-50 dark:bg-white dark:text-gray-950">
          {pending ? t('updating') : t('changePassword')}
        </button>
      </form>
    </section>
  );
}
