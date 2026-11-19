export const activityEventTypes = [
  'account_created', 'account_profile_updated', 'account_email_changed',
  'security_email_verified', 'security_email_unverified', 'security_password_changed', 'security_session_created',
  'billing_checkout_created', 'billing_payment_confirmed', 'billing_payment_reversed', 'billing_payment_restored',
  'billing_access_granted', 'billing_access_revoked', 'billing_access_restored',
] as const;
export type ActivityEventType = typeof activityEventTypes[number];
export type ActivityCategory = 'account' | 'security' | 'billing';
export type ActivityItem = { id: string; type: ActivityEventType; category: ActivityCategory; occurredAt: string };
export type ActivityFeed = { items: ActivityItem[]; nextCursor: string | null };
export function activityCategory(type: ActivityEventType): ActivityCategory {
  return type.startsWith('billing_') ? 'billing' : type.startsWith('security_') ? 'security' : 'account';
}
