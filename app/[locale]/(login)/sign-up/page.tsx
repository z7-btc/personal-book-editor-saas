import { Login } from '../login';
import { getCapabilities } from '@/lib/config';
import { configuredProviders } from '@/lib/auth/social';

export const dynamic = 'force-dynamic';

export default function SignUpPage() {
  const capabilities = getCapabilities();
  const turnstile = capabilities.turnstile;
  const requiresTurnstile = process.env.NODE_ENV === 'production' || turnstile.enabled;
  // No `socialError` here: a provider callback always lands on /sign-in, so a
  // failure sentence on the sign-up page would have no way to be set.
  return (
    <Login mode="signup" requiresTurnstile={requiresTurnstile}
      turnstileReady={turnstile.configured}
      siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || ''}
      socialProviders={configuredProviders({
        google: capabilities.googleOAuth.configured,
        github: capabilities.githubOAuth.configured,
      })} />
  );
}
