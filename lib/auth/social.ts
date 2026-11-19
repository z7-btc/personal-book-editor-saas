/**
 * Which sentence a failed provider callback earns, and which providers a login
 * page may offer.
 *
 * The codes below are Better Auth's OAuth callback redirect codes, delivered as
 * `?error=<code>` on the `errorCallbackURL`
 * (`better-auth/dist/oauth2/errors.mjs`). Codes the provider reports about
 * itself — a user pressing "cancel" comes back as `access_denied` — and any code
 * a future version adds fall into the generic bucket, so a reader never meets an
 * empty alert.
 *
 * Deliberately not `server-only`: `components/auth/social-sign-in.tsx` is a
 * client component and imports the mapping from here.
 */

export const SOCIAL_PROVIDERS = ['google', 'github'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/**
 * The providers a deployment may offer, given what its capability matrix
 * reports. Kept here so the sign-in and sign-up pages cannot disagree about
 * which buttons exist.
 */
export function configuredProviders(flags: Record<SocialProvider, boolean>): SocialProvider[] {
  return SOCIAL_PROVIDERS.filter((provider) => flags[provider]);
}

export type SocialMessageKey =
  | 'socialErrorEmailNotVerified'
  | 'socialErrorEmailNotFound'
  | 'socialErrorEmailMismatch'
  | 'socialErrorAccountTaken'
  | 'socialErrorLinkFailed'
  | 'socialErrorFlow'
  | 'socialErrorGeneric';

const ERROR_MESSAGE_KEYS: Record<string, SocialMessageKey> = {
  email_not_verified: 'socialErrorEmailNotVerified',
  email_not_found: 'socialErrorEmailNotFound',
  email_does_not_match: 'socialErrorEmailMismatch',
  account_already_linked_to_different_user: 'socialErrorAccountTaken',
  unable_to_link_account: 'socialErrorLinkFailed',
  unable_to_get_user_info: 'socialErrorFlow',
  no_code: 'socialErrorFlow',
  invalid_state: 'socialErrorFlow',
  state_not_found: 'socialErrorFlow',
};

/** `null` means the callback reported no error, so nothing should be shown. */
export function socialErrorMessageKey(error: string | undefined): SocialMessageKey | null {
  if (!error) return null;
  return ERROR_MESSAGE_KEYS[error] ?? 'socialErrorGeneric';
}
