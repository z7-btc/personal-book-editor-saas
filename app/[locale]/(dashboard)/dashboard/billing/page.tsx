import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getBillingHistory } from '@/lib/billing/history';
import { BillingHistoryView } from './billing-history';

export default async function BillingPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  const initial = session ? await getBillingHistory(session.user.id).catch(() => null) : null;
  return <BillingHistoryView initial={initial} />;
}
