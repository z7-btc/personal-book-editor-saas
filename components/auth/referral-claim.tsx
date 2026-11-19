'use client';

import { useEffect } from 'react';

export function ReferralClaim({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    void fetch('/api/referrals/claim', { method: 'POST', credentials: 'same-origin' });
  }, [enabled]);
  return null;
}
