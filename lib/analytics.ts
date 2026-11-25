/**
 * A GA4 measurement id is a public identifier (`G-...`). It is interpolated
 * into the inline gtag bootstrap, so a malformed environment value must be
 * refused here instead of being pasted into script text: whatever passes this
 * check ends up inside `<script>` content, and only the standard id shape may
 * pass. Returns the canonical upper-case id, or null when analytics should
 * stay disabled (unset or invalid).
 */
export function resolveGoogleAnalyticsId(raw: string | undefined): string | null {
  const id = raw?.trim().toUpperCase();
  return id && /^G-[A-Z0-9]{4,20}$/.test(id) ? id : null;
}
