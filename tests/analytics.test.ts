import { describe, expect, it } from 'vitest';
import { resolveGoogleAnalyticsId } from '@/lib/analytics';

/**
 * The measurement id ends up inside the inline gtag bootstrap, so this
 * validator is load-bearing for script safety, not just for typo hygiene.
 * Everything that is not a plain G- id must resolve to null (analytics off).
 */
describe('resolveGoogleAnalyticsId', () => {
  it('accepts the standard G- shape and normalises case', () => {
    expect(resolveGoogleAnalyticsId('G-Q6FKNRR5MN')).toBe('G-Q6FKNRR5MN');
    expect(resolveGoogleAnalyticsId('  g-q6fknrr5mn  ')).toBe('G-Q6FKNRR5MN');
  });

  it('keeps analytics off when the variable is unset or empty', () => {
    expect(resolveGoogleAnalyticsId(undefined)).toBeNull();
    expect(resolveGoogleAnalyticsId('')).toBeNull();
    expect(resolveGoogleAnalyticsId('   ')).toBeNull();
  });

  it('refuses values that are not a measurement id', () => {
    expect(resolveGoogleAnalyticsId('UA-1234-1')).toBeNull();
    expect(resolveGoogleAnalyticsId('GTM-WKVNHQX6')).toBeNull();
    expect(resolveGoogleAnalyticsId('G-')).toBeNull();
    expect(resolveGoogleAnalyticsId('G-Q6FK NRR5MN')).toBeNull();
  });

  it('refuses values that would break out of the inline script', () => {
    expect(resolveGoogleAnalyticsId("G-AAAA');alert(1);//")).toBeNull();
    expect(resolveGoogleAnalyticsId('G-AAAA</script><script>alert(1)</script>')).toBeNull();
  });
});
