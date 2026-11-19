import { getCapabilities } from '@/lib/config';
import { PasswordResetFlow } from '@/components/auth/password-reset-flow';

export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage() {
  const capabilities = getCapabilities();
  return <PasswordResetFlow mode="request"
    available={capabilities.transactionalEmail.configured}
    requiresTurnstile={process.env.NODE_ENV === 'production' || capabilities.turnstile.enabled}
    turnstileReady={capabilities.turnstile.configured}
    siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || ''} />;
}
