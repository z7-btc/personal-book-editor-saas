import { headers } from 'next/headers';
import { getLocale } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getAccountActivity } from '@/lib/activity/feed';
import { logObservation } from '@/lib/observability/logger';
import type { ActivityFeed } from '@/lib/activity/events';
import ActivityClient from './activity-client';

export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  const locale = await getLocale();
  let initial: ActivityFeed | null = null;
  let unavailable = false;
  try { initial = await getAccountActivity(await headers()); }
  catch {
    unavailable = true;
    logObservation({ event: 'activity.failure', code: 'ACTIVITY_UNAVAILABLE', level: 'error' });
  }
  if (!initial && !unavailable) redirect(`/${locale}/sign-in`);
  return <ActivityClient initial={initial} unavailable={unavailable} />;
}
