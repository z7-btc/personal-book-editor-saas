import Script from 'next/script';

/**
 * GA4 through the standard gtag bootstrap. `next/script` injects both tags
 * after the page becomes interactive instead of rendering raw <script> nodes
 * into the React tree — React 19 replaces inline scripts it renders with inert
 * nodes after hydration (see the theme comment in the locale layout), so the
 * Script component is the only shape that actually runs on client navigation.
 *
 * `measurementId` must already be validated by `resolveGoogleAnalyticsId`;
 * that check is what keeps the interpolated string below free of script text.
 */
export function GoogleAnalytics({ measurementId }: { measurementId: string }) {
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
        strategy="afterInteractive"
      />
      <Script id="google-analytics" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${measurementId}');`}
      </Script>
    </>
  );
}
