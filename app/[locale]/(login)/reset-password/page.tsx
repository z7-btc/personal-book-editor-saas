import { getCapabilities } from '@/lib/config';
import { PasswordResetFlow } from '@/components/auth/password-reset-flow';

export const dynamic = 'force-dynamic';

export default async function ResetPasswordPage({ searchParams }: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  return <PasswordResetFlow mode="reset"
    available={getCapabilities().transactionalEmail.configured}
    resetToken={token} invalidToken={Boolean(error)} />;
}
