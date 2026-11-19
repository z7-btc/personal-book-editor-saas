'use client';

import { useEffect, useRef } from 'react';

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    }
  ) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function TurnstileWidget({
  siteKey,
  onToken,
  resetKey,
}: {
  siteKey: string;
  onToken: (token: string) => void;
  resetKey: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const callbackRef = useRef(onToken);
  callbackRef.current = onToken;

  useEffect(() => {
    let disposed = false;
    const render = () => {
      if (disposed || !containerRef.current || !window.turnstile || widgetIdRef.current) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        action: 'saas_auth',
        callback: (token) => callbackRef.current(token),
        'expired-callback': () => callbackRef.current(''),
        'error-callback': () => callbackRef.current(''),
      });
    };

    const existing = document.querySelector<HTMLScriptElement>('script[data-saas-turnstile]');
    const script = existing || document.createElement('script');
    if (!existing) {
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.dataset.saasTurnstile = 'true';
      document.head.appendChild(script);
    }
    script.addEventListener('load', render);
    render();

    return () => {
      disposed = true;
      script.removeEventListener('load', render);
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey > 0 && widgetIdRef.current && window.turnstile) {
      callbackRef.current('');
      window.turnstile.reset(widgetIdRef.current);
    }
  }, [resetKey]);

  // No aria-label here: ARIA 1.2 forbids naming a role-less generic element
  // (axe `aria-prohibited-attr`), and Cloudflare's own iframe carries the
  // accessible name for the challenge it renders into this container.
  return <div ref={containerRef} />;
}
