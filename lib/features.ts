/**
 * The feature-gate surface, re-exported so a component, a script and a test all
 * read the same list. `lib/config.ts` owns the values; this module only names
 * them and never invents a second set of defaults.
 *
 * The names live in a frozen array because the capability matrix, the security
 * test and the environment documentation all have to agree on the complete set.
 */
export const featureNames = [
  'paymentCenter',
  'referrals',
  'referralWithdrawals',
  'commissionBalance',
  'emailCenter',
  'emailWidget',
  'transactionalEmail',
  'turnstile',
  'googleOAuth',
  'githubOAuth',
] as const;

export type FeatureName = typeof featureNames[number];

export { features, getCapabilities, requireCapability } from './config';
export type { Capability } from './config';
