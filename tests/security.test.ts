import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan acceptance criterion 4 and 5: the default local matrix keeps every
 * third-party capability disabled, and enabling one without its keys must fail
 * closed instead of half-working. `/api/ready` reports the same verdict.
 */
const THIRD_PARTY_FLAGS = [
  'FEATURE_PAYMENT_CENTER',
  'FEATURE_REFERRALS',
  'FEATURE_REFERRAL_WITHDRAWALS',
  'FEATURE_COMMISSION_BALANCE',
  'FEATURE_EMAIL_CENTER',
  'FEATURE_EMAIL_CENTER_WIDGET',
  'FEATURE_TRANSACTIONAL_EMAIL',
  'FEATURE_TURNSTILE',
  'FEATURE_GOOGLE_OAUTH',
  'FEATURE_GITHUB_OAUTH',
] as const;

const CAPABILITY_KEYS = [
  'PAYMENT_CENTER_BASE_URL',
  'PAYMENT_CENTER_API_KEY',
  'PAYMENT_CENTER_SITE_CODE',
  'PAYMENT_CENTER_WEBSITE_ID',
  'PAYMENT_CENTER_CALLBACK_SIGNING_SECRET',
  'PAYMENT_CENTER_REFERRAL_API_KEY',
  'PAYMENT_CENTER_WITHDRAWAL_API_KEY',
  'REFERRAL_WITHDRAWAL_REQUEST_SECRET',
  'EMAIL_CENTER_URL',
  'EMAIL_CENTER_API_KEY',
  'NEXT_PUBLIC_EMAIL_CENTER_WIDGET_KEY',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'APP_BASE_URL',
  'CRON_SECRET',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'TURNSTILE_SECRET_KEY',
  'TURNSTILE_ALLOWED_HOSTNAMES',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'INTEGRATION_ENCRYPTION_ACTIVE_VERSION',
  'INTEGRATION_ENCRYPTION_KEY_V1',
] as const;

function clearMatrix() {
  for (const name of [...THIRD_PARTY_FLAGS, ...CAPABILITY_KEYS]) {
    vi.stubEnv(name, '');
  }
}

async function loadConfig() {
  vi.resetModules();
  return import('@/lib/config');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('feature matrix', () => {
  it('keeps every third-party capability disabled when nothing is enabled', async () => {
    clearMatrix();
    const { features, getCapabilities } = await loadConfig();
    expect(features).toEqual({
      paymentCenter: false,
      referrals: false,
      referralWithdrawals: false,
      commissionBalance: false,
      emailCenter: false,
      emailWidget: false,
      transactionalEmail: false,
      turnstile: false,
      googleOAuth: false,
      githubOAuth: false,
    });
    const capabilities = getCapabilities();
    for (const capability of Object.values(capabilities)) {
      expect(capability.enabled).toBe(false);
      expect(capability.configured).toBe(false);
      // A disabled capability never inspects or leaks a third-party key name.
      expect(capability.missing).toEqual([]);
    }
  });

  it('treats only the literal string "true" as enabled', async () => {
    clearMatrix();
    vi.stubEnv('FEATURE_PAYMENT_CENTER', 'TRUE');
    vi.stubEnv('FEATURE_EMAIL_CENTER', '1');
    const { features } = await loadConfig();
    expect(features.paymentCenter).toBe(false);
    expect(features.emailCenter).toBe(false);
  });

  it('fails closed and names the missing keys when a capability is enabled without them', async () => {
    clearMatrix();
    vi.stubEnv('FEATURE_PAYMENT_CENTER', 'true');
    const { getCapabilities } = await loadConfig();
    const { paymentCenter } = getCapabilities();
    expect(paymentCenter.enabled).toBe(true);
    expect(paymentCenter.configured).toBe(false);
    expect(paymentCenter.missing).toEqual([
      'PAYMENT_CENTER_BASE_URL',
      'PAYMENT_CENTER_API_KEY',
      'PAYMENT_CENTER_SITE_CODE',
      'PAYMENT_CENTER_WEBSITE_ID',
      'PAYMENT_CENTER_CALLBACK_SIGNING_SECRET',
      // The empty secret is also shorter than the required 32 bytes.
      '32-byte callback signing secret',
    ]);
  });

  it('reports a capability as configured once every required key is present', async () => {
    clearMatrix();
    vi.stubEnv('FEATURE_PAYMENT_CENTER', 'true');
    vi.stubEnv('PAYMENT_CENTER_BASE_URL', 'http://127.0.0.1:5000');
    vi.stubEnv('PAYMENT_CENTER_API_KEY', 'local-key');
    vi.stubEnv('PAYMENT_CENTER_SITE_CODE', 'saas-framework');
    vi.stubEnv('PAYMENT_CENTER_WEBSITE_ID', '00000000-0000-4000-8000-000000000001');
    vi.stubEnv('PAYMENT_CENTER_CALLBACK_SIGNING_SECRET', 'a'.repeat(32));
    const { getCapabilities } = await loadConfig();
    const { paymentCenter } = getCapabilities();
    expect(paymentCenter.configured).toBe(true);
    expect(paymentCenter.missing).toEqual([]);
  });

  it('rejects a short callback signing secret even when one is configured', async () => {
    clearMatrix();
    vi.stubEnv('FEATURE_PAYMENT_CENTER', 'true');
    vi.stubEnv('PAYMENT_CENTER_BASE_URL', 'http://127.0.0.1:5000');
    vi.stubEnv('PAYMENT_CENTER_API_KEY', 'local-key');
    vi.stubEnv('PAYMENT_CENTER_SITE_CODE', 'saas-framework');
    vi.stubEnv('PAYMENT_CENTER_WEBSITE_ID', '00000000-0000-4000-8000-000000000001');
    vi.stubEnv('PAYMENT_CENTER_CALLBACK_SIGNING_SECRET', 'too-short');
    const { getCapabilities } = await loadConfig();
    expect(getCapabilities().paymentCenter.missing).toEqual(['32-byte callback signing secret']);
  });

  it('keeps referrals disabled by default and requires an encryption key for withdrawals', async () => {
    clearMatrix();
    vi.stubEnv('FEATURE_REFERRAL_WITHDRAWALS', 'true');
    vi.stubEnv('REFERRAL_WITHDRAWAL_REQUEST_SECRET', 'b'.repeat(32));
    vi.stubEnv('INTEGRATION_ENCRYPTION_ACTIVE_VERSION', 'v1');
    const { getCapabilities } = await loadConfig();
    const capabilities = getCapabilities();
    // Without an active encryption key the withdrawal channel stays closed.
    expect(capabilities.referralWithdrawals.enabled).toBe(true);
    expect(capabilities.referralWithdrawals.configured).toBe(false);
    expect(capabilities.referrals.configured).toBe(false);
  });

  it('rejects a malformed encryption key version', async () => {
    clearMatrix();
    vi.stubEnv('FEATURE_REFERRAL_WITHDRAWALS', 'true');
    vi.stubEnv('INTEGRATION_ENCRYPTION_ACTIVE_VERSION', 'v0');
    const { getCapabilities } = await loadConfig();
    expect(getCapabilities().referralWithdrawals.configured).toBe(false);
  });

  it('refuses Cloudflare test keys in production', async () => {
    clearMatrix();
    vi.stubEnv('FEATURE_TURNSTILE', 'true');
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
    vi.stubEnv('TURNSTILE_SECRET_KEY', '1x0000000000000000000000000000000AA');
    vi.stubEnv('TURNSTILE_ALLOWED_HOSTNAMES', 'localhost');
    vi.stubEnv('NODE_ENV', 'production');
    const { getCapabilities } = await loadConfig();
    const { turnstile } = getCapabilities();
    expect(turnstile.configured).toBe(false);
    expect(turnstile.missing).toContain('production Turnstile widget');
  });

  it('requireCapability throws a message naming exactly what is missing', async () => {
    clearMatrix();
    vi.stubEnv('FEATURE_EMAIL_CENTER', 'true');
    vi.stubEnv('EMAIL_CENTER_API_KEY', 'present');
    const { requireCapability } = await loadConfig();
    expect(() => requireCapability('emailCenter')).toThrowError(
      'emailCenter is unavailable: EMAIL_CENTER_URL'
    );
  });

  it('requireCapability is silent for a fully configured capability', async () => {
    clearMatrix();
    vi.stubEnv('FEATURE_EMAIL_CENTER', 'true');
    vi.stubEnv('EMAIL_CENTER_URL', 'http://127.0.0.1:3100');
    vi.stubEnv('EMAIL_CENTER_API_KEY', 'local-key');
    const { requireCapability } = await loadConfig();
    expect(() => requireCapability('emailCenter')).not.toThrow();
  });
});
