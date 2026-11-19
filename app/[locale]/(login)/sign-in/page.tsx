import { Login } from '../login';
import { getCapabilities } from '@/lib/config';
import { configuredProviders } from '@/lib/auth/social';

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const capabilities = getCapabilities();
  const turnstile = capabilities.turnstile;
  const requiresTurnstile = process.env.NODE_ENV === 'production' || turnstile.enabled;
  // Better Auth redirects a failed provider callback here with `?error=<code>`.
  const { error } = await searchParams;
  return (
    <Login mode="signin" requiresTurnstile={requiresTurnstile}
      turnstileReady={turnstile.configured}
      siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || ''}
      passwordResetAvailable={capabilities.transactionalEmail.configured}
      socialProviders={configuredProviders({
        google: capabilities.googleOAuth.configured,
        github: capabilities.githubOAuth.configured,
      })}
      socialError={error} />
  );
}
