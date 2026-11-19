'use client';

import { useEffect } from 'react';

/*
 * Shell around the remote payment widget.
 *
 * The colours here are literal on purpose, not theme tokens: the remote card
 * inside is always white, and this site's default theme is dark. Inheriting
 * `--foreground` into a white card would render white-on-white.
 * (Do not write bracketed Tailwind class names in this comment — Tailwind
 * scans comments too and could emit invalid CSS.)
 */
export function PaymentWindow({ title, closeLabel, onClose, children }: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-slate-200 bg-white p-5 text-slate-900 shadow-2xl [color-scheme:light] sm:p-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h3 className="text-xl font-bold tracking-tight text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
            {closeLabel}
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
