import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const nextConfig: NextConfig = {
  logging: {
    // Verification/reset links contain bearer tokens. Keep their raw URL out
    // of the development request log; business diagnostics use redacted data.
    incomingRequests: { ignore: [/\/api\/auth\/(?:verify-email|reset-password)(?:\/|\?|$)/] },
    serverFunctions: false,
  },
  // Cache Components can be enabled once every route has been migrated from
  // the upstream Next.js 15 starter and audited for dynamic data access.
};

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

export default withNextIntl(nextConfig);
