import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { ensurePersonalWorkspace } from '@/lib/workspace/bootstrap';
import { getCapabilities } from '@/lib/config';
import { ReferralClaim } from '@/components/auth/referral-claim';
import { client } from '@/lib/db/drizzle';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const t = await getTranslations('Dashboard');
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  try {
    await ensurePersonalWorkspace(session.user.id, session.user.name);
  } catch {
    return (
      <section className="rounded-xl border bg-white p-8 dark:border-gray-700 dark:bg-gray-900">
        <h1 className="text-2xl font-semibold">{t('setupPending')}</h1>
        <p className="mt-3 text-gray-600 dark:text-gray-300">{t('setupRetry')}</p>
      </section>
    );
  }

  const capabilities = getCapabilities();
  const locale = await getLocale();
  const [referral] = capabilities.referrals.configured ? await client`
    SELECT p.invite_code, (
      SELECT status::text FROM referral_user_outbox
      WHERE user_id = p.user_id ORDER BY event_version DESC LIMIT 1
    ) AS sync_status
    FROM referral_profiles p WHERE p.user_id = ${session.user.id}
  ` : [];
  const inviteUrl = referral?.sync_status === 'succeeded'
    ? `${(process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')}/${locale}/invite/${referral.invite_code}`
    : null;
  return (
    <div className="space-y-8">
      <ReferralClaim enabled={capabilities.referrals.configured} />
      <section className="rounded-xl border bg-white p-8 dark:border-gray-700 dark:bg-gray-900">
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('personalWorkspace')}</p>
        <h1 className="mt-2 text-3xl font-semibold">{session.user.name}</h1>
        <p className="mt-3 text-gray-600 dark:text-gray-300">{t('signedInAs', { email: session.user.email })}</p>
        {!session.user.emailVerified && (
          <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">{t('emailUnconfirmed')}</p>
        )}
      </section>
      <section className="rounded-xl border bg-white p-8 dark:border-gray-700 dark:bg-gray-900">
        <h2 className="text-xl font-semibold">{t('services')}</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <p>{t('payments')}: {capabilities.paymentCenter.configured ? t('configured') : t('notConfigured')}</p>
          <p>{t('emailContacts')}: {capabilities.emailCenter.configured ? t('configured') : t('notConfigured')}</p>
          <p>{t('referrals')}: {capabilities.referrals.configured ? t('configured') : t('notConfigured')}</p>
        </div>
        <p className="mt-5 text-sm text-gray-500 dark:text-gray-400">
          {t('servicesDescription')}
        </p>
        <Link href="/dashboard/general" className="mt-5 inline-block text-sm font-medium underline">
          {t('accountSettings')}
        </Link>
      </section>
      {capabilities.referrals.configured && (
        <section className="rounded-xl border bg-white p-8 dark:border-gray-700 dark:bg-gray-900">
          <h2 className="text-xl font-semibold">{t('inviteTitle')}</h2>
          {inviteUrl ? (
            <>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{t('inviteDescription')}</p>
              <a className="mt-4 block break-all text-sm font-medium underline" href={inviteUrl}>{inviteUrl}</a>
            </>
          ) : (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{t('invitePending')}</p>
          )}
        </section>
      )}
    </div>
  );
}
