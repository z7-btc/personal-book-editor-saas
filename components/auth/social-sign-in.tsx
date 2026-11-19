'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { authClient } from '@/lib/auth-client';
import { socialErrorMessageKey, type SocialProvider } from '@/lib/auth/social';
import { ProviderIcon } from '@/components/auth/provider-icons';

const LABELS: Record<SocialProvider, 'socialGoogle' | 'socialGithub'> = {
  google: 'socialGoogle',
  github: 'socialGithub',
};

/**
 * The "sign in with …" block: one button per provider the deployment has keys
 * for, the divider that separates them from the password form above, and the
 * sentence a failed provider callback earns. It sits below the form, the way
 * GitHub's own sign-in page does, so the password path keeps the top of the card.
 *
 * `providers` is decided by the server components from the capability matrix, so
 * a half-configured deployment renders nothing here rather than a button that
 * cannot work. The early return covers the divider too — an orphaned "or" under
 * the password form would read as a broken page.
 *
 * `error` arrives as `?error=<code>` on the redirect back from Better Auth when
 * a callback fails; `lib/auth/social.ts` owns the code-to-sentence mapping.
 */
export function SocialSignIn({ providers, error }: {
  providers: SocialProvider[];
  error?: string;
}) {
  const t = useTranslations('Login');
  const locale = useLocale();
  const [pending, setPending] = useState<SocialProvider | null>(null);
  const [failed, setFailed] = useState(false);

  async function start(provider: SocialProvider) {
    if (pending) return;
    setPending(provider);
    setFailed(false);
    const settings = {
      provider,
      // The reader's locale, not the middleware's guess: `localePrefix` is
      // 'always', so a bare /dashboard is re-routed with the locale the
      // middleware infers from Accept-Language, which may not be this page's.
      callbackURL: `/${locale}/dashboard`,
      errorCallbackURL: `/${locale}/sign-in`,
    };
    try {
      const result = await authClient.signIn.social(settings);
      // The client navigates to the provider on success, so reaching here with
      // no error means the browser is already leaving. A returned error (rather
      // than a thrown one) still has to land somewhere visible.
      if (result?.error) {
        setFailed(true);
        setPending(null);
      }
    } catch {
      setFailed(true);
      setPending(null);
    }
  }

  if (providers.length === 0) return null;

  const messageKey = failed ? 'socialErrorGeneric' : socialErrorMessageKey(error);

  return (
    <div className="mt-6 space-y-3">
      <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
        <span aria-hidden="true" className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
        {t('socialOr')}
        <span aria-hidden="true" className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
      </div>
      {/* Below the divider, so the sentence reads as being about the buttons it
          sits on top of rather than about the password form above it. */}
      {messageKey && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">{t(messageKey)}</p>
      )}
      {providers.map((provider) => (
        <button key={provider} type="button" onClick={() => start(provider)}
          disabled={pending !== null}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 px-4 py-3 font-medium disabled:opacity-50 dark:border-gray-600">
          <ProviderIcon provider={provider} />
          {pending === provider ? t('socialPending') : t(LABELS[provider])}
        </button>
      ))}
    </div>
  );
}
