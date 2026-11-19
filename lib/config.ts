/** Central feature gates. Disabled integrations never read a third-party key. */
export const features = {
  paymentCenter: process.env.FEATURE_PAYMENT_CENTER === 'true',
  referrals: process.env.FEATURE_REFERRALS === 'true',
  referralWithdrawals: process.env.FEATURE_REFERRAL_WITHDRAWALS === 'true',
  commissionBalance: process.env.FEATURE_COMMISSION_BALANCE === 'true',
  emailCenter: process.env.FEATURE_EMAIL_CENTER === 'true',
  emailWidget: process.env.FEATURE_EMAIL_CENTER_WIDGET === 'true',
  transactionalEmail: process.env.FEATURE_TRANSACTIONAL_EMAIL === 'true',
  turnstile: process.env.FEATURE_TURNSTILE === 'true',
  googleOAuth: process.env.FEATURE_GOOGLE_OAUTH === 'true',
  githubOAuth: process.env.FEATURE_GITHUB_OAUTH === 'true',
} as const;

export type Capability = {
  enabled: boolean;
  configured: boolean;
  missing: string[];
};

function capability(enabled: boolean, required: string[]): Capability {
  const missing = enabled
    ? required.filter((key) => !process.env[key]?.trim())
    : [];
  return { enabled, configured: enabled && missing.length === 0, missing };
}

export function getCapabilities() {
  const turnstile = capability(features.turnstile, [
    'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
    'TURNSTILE_SECRET_KEY',
    'TURNSTILE_ALLOWED_HOSTNAMES',
  ]);
  const testingWidget = /^[123]x00000000000000000000/.test(
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || ''
  );
  const testingSecret = /^[123]x0000000000000000000000000000000/.test(
    process.env.TURNSTILE_SECRET_KEY || ''
  );
  if (process.env.NODE_ENV === 'production' && (testingWidget || testingSecret)) {
    turnstile.configured = false;
    turnstile.missing.push('production Turnstile widget');
  }
  const paymentCenter = capability(features.paymentCenter, [
      'PAYMENT_CENTER_BASE_URL',
      'PAYMENT_CENTER_API_KEY',
      'PAYMENT_CENTER_SITE_CODE',
      'PAYMENT_CENTER_WEBSITE_ID',
      'PAYMENT_CENTER_CALLBACK_SIGNING_SECRET',
    ]);
  if (paymentCenter.enabled &&
      (process.env.PAYMENT_CENTER_CALLBACK_SIGNING_SECRET || '').length < 32) {
    paymentCenter.configured = false;
    paymentCenter.missing.push('32-byte callback signing secret');
  }
  const referrals = capability(features.referrals, [
    'APP_BASE_URL',
    'PAYMENT_CENTER_BASE_URL',
    'PAYMENT_CENTER_SITE_CODE',
    'PAYMENT_CENTER_WEBSITE_ID',
    'PAYMENT_CENTER_REFERRAL_API_KEY',
  ]);
  if (referrals.enabled && process.env.NODE_ENV === 'production') {
    try {
      const origin = new URL(process.env.APP_BASE_URL || '');
      if (origin.protocol !== 'https:' || origin.hostname === 'localhost' ||
          origin.hostname === '127.0.0.1' || origin.pathname !== '/' ||
          origin.search || origin.hash || origin.username || origin.password) {
        throw new Error('Public HTTPS origin required.');
      }
    } catch {
      referrals.configured = false;
      referrals.missing.push('public APP_BASE_URL');
    }
  }
  // Commission settling on payment/refund follows referrals but adds its own
  // credential pair: a payment_ingest key and the shared HMAC secret used to
  // sign the ingest. It is reported separately so a missing ingest credential
  // surfaces on the readiness probe without dragging referral attribution down.
  const referralPurchaseIngest = capability(features.referrals, [
    'PAYMENT_CENTER_PAYMENT_INGEST_API_KEY',
    'REFERRAL_PAYMENT_INGEST_SECRET',
  ]);
  if (referralPurchaseIngest.enabled &&
      (process.env.REFERRAL_PAYMENT_INGEST_SECRET || '').length < 32) {
    referralPurchaseIngest.configured = false;
    referralPurchaseIngest.missing.push('32-byte payment ingest signing secret');
  }
  const transactionalEmail = capability(features.transactionalEmail, [
    'APP_BASE_URL', 'RESEND_API_KEY', 'EMAIL_FROM',
  ]);
  if (transactionalEmail.enabled && process.env.NODE_ENV === 'production') {
    try {
      const origin = new URL(process.env.APP_BASE_URL || '');
      if (origin.protocol !== 'https:' || origin.hostname === 'localhost' ||
          origin.hostname === '127.0.0.1' || origin.pathname !== '/' ||
          origin.search || origin.hash || origin.username || origin.password) {
        throw new Error('Public HTTPS origin required.');
      }
    } catch {
      transactionalEmail.configured = false;
      transactionalEmail.missing.push('public APP_BASE_URL');
    }
  }
  const referralWithdrawals = capability(features.referralWithdrawals, [
    'PAYMENT_CENTER_BASE_URL', 'PAYMENT_CENTER_WEBSITE_ID',
    'PAYMENT_CENTER_WITHDRAWAL_API_KEY', 'REFERRAL_WITHDRAWAL_REQUEST_SECRET',
    'INTEGRATION_ENCRYPTION_ACTIVE_VERSION',
  ]);
  const activeKeyVersion = process.env.INTEGRATION_ENCRYPTION_ACTIVE_VERSION || '';
  if (referralWithdrawals.enabled &&
      (!referrals.configured || !transactionalEmail.configured ||
       !/^v[1-9][0-9]*$/.test(activeKeyVersion) ||
       !process.env[`INTEGRATION_ENCRYPTION_KEY_${activeKeyVersion.toUpperCase()}`] ||
       (process.env.REFERRAL_WITHDRAWAL_REQUEST_SECRET || '').length < 32)) {
    referralWithdrawals.configured = false;
    referralWithdrawals.missing.push('referral, mail, encryption or 32-byte withdrawal signing setup');
  }
  return {
    paymentCenter,
    referrals,
    referralPurchaseIngest,
    referralWithdrawals,
    emailCenter: capability(features.emailCenter, [
      'EMAIL_CENTER_URL',
      'EMAIL_CENTER_API_KEY',
    ]),
    emailWidget: capability(features.emailWidget, [
      'EMAIL_CENTER_URL',
      'NEXT_PUBLIC_EMAIL_CENTER_WIDGET_KEY',
    ]),
    transactionalEmail,
    turnstile,
    googleOAuth: capability(features.googleOAuth, [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
    ]),
    githubOAuth: capability(features.githubOAuth, [
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
    ]),
  };
}

export function requireCapability(name: keyof ReturnType<typeof getCapabilities>) {
  const result = getCapabilities()[name];
  if (!result.configured) {
    throw new Error(`${name} is unavailable${result.missing.length ? `: ${result.missing.join(', ')}` : ''}`);
  }
}
