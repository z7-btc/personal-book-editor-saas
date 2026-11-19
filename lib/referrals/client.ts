import { requireCapability } from '@/lib/config';

export async function verifyReferralBinding(send: typeof fetch = fetch): Promise<boolean> {
  requireCapability('referrals');
  const endpoint = new URL('/api/referral-center/site', process.env.PAYMENT_CENTER_BASE_URL);
  if (process.env.NODE_ENV === 'production' && endpoint.protocol !== 'https:') return false;
  const response = await send(endpoint, {
    headers: { 'X-API-Key': process.env.PAYMENT_CENTER_REFERRAL_API_KEY! },
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return false;
  const body = await response.json() as { data?: { website?: {
    id?: string; site_code?: string; is_active?: boolean;
  } } };
  const website = body.data?.website;
  return website?.id === process.env.PAYMENT_CENTER_WEBSITE_ID &&
    website?.site_code === process.env.PAYMENT_CENTER_SITE_CODE &&
    website?.is_active === true;
}
