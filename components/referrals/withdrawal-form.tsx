'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

type WithdrawalResult = {
  id: string; amount: string; currency: string; method: string;
  blockchain: string | null; accountMask: string; status: string;
  errorCode: string | null;
};
type Payload = {
  requestKey: string; amount: string; currency: 'USDT';
  method: 'BINANCE_UID' | 'BLOCKCHAIN'; blockchain: 'BSC' | 'ARBITRUM' | null;
  payoutAccount: string;
};
const storageKey = 'saas_referral_withdrawal_request_key';

export default function WithdrawalForm({ available, minimum, disabledReason }: {
  available: string; minimum: string; disabledReason: string | null;
}) {
  const t = useTranslations('Withdrawal');
  const [method, setMethod] = useState<'BINANCE_UID' | 'BLOCKCHAIN'>('BINANCE_UID');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WithdrawalResult | null>(null);
  const [message, setMessage] = useState('');
  const [unknown, setUnknown] = useState(false);
  const requestKey = useRef<string | null>(null);
  const pendingPayload = useRef<Payload | null>(null);

  async function checkSavedRequest(key: string): Promise<'found' | 'missing' | 'failed'> {
    try {
      const response = await fetch(`/api/referrals/withdrawals?requestKey=${encodeURIComponent(key)}`, {
        cache: 'no-store', credentials: 'same-origin',
      });
      if (response.status === 404) {
        sessionStorage.removeItem(storageKey);
        requestKey.current = null;
        pendingPayload.current = null;
        setUnknown(false);
        return 'missing';
      }
      const body = await response.json() as { data?: WithdrawalResult };
      if (response.ok && body.data) {
        setResult(body.data);
        setUnknown(false);
        pendingPayload.current = null;
        return 'found';
      }
    } catch { /* The original request may still be running. */ }
    setUnknown(true);
    return 'failed';
  }

  useEffect(() => {
    const saved = sessionStorage.getItem(storageKey);
    if (!saved) return;
    requestKey.current = saved;
    // The recovery probe reads and writes the session record, so it runs from a
    // timer task rather than synchronously inside the effect body: the effect
    // contributes no state during its own render pass, and a setState that
    // lands later cannot cascade into it.
    const timer = setTimeout(() => {
      void checkSavedRequest(saved).then((outcome) => {
        if (outcome === 'failed') setMessage(t('checkFailed'));
      });
    }, 0);
    return () => clearTimeout(timer);
    // Recovery is tied to the mounted account view, not to a form state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!result || !['pending', 'sending', 'uncertain'].includes(result.status)) return;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/referrals/withdrawals/${result.id}`, {
          cache: 'no-store', credentials: 'same-origin',
        });
        const body = await response.json() as { data?: WithdrawalResult };
        if (response.ok && body.data) setResult(body.data);
      } catch { /* The recovery worker continues; keep the last known status. */ }
    }, 5_000);
    return () => clearInterval(timer);
  }, [result]);

  async function submit(payload: Payload) {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/referrals/withdrawals', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as { data?: WithdrawalResult; error?: string };
      if (body.data) {
        setResult(body.data);
        setUnknown(false);
        pendingPayload.current = null;
      } else {
        setMessage(t(body.error === 'recent_sign_in_required' ? 'signInAgain'
          : body.error === 'email_unconfirmed' ? 'confirmEmail'
          : body.error === 'rate_limited' ? 'rateLimited'
          : body.error === 'withdrawal_conflict' ? 'conflict' : 'submitFailed'));
        const recovered = await checkSavedRequest(payload.requestKey);
        if (recovered === 'missing' && response.status >= 500) {
          requestKey.current = payload.requestKey;
          sessionStorage.setItem(storageKey, payload.requestKey);
          pendingPayload.current = payload;
          setUnknown(true);
        }
      }
    } catch {
      const recovered = await checkSavedRequest(payload.requestKey);
      if (recovered !== 'found') {
        if (recovered === 'missing') {
          requestKey.current = payload.requestKey;
          sessionStorage.setItem(storageKey, payload.requestKey);
          pendingPayload.current = payload;
        }
        setUnknown(true);
        setMessage(t('resultUnknown'));
      }
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const key = requestKey.current || crypto.randomUUID();
    requestKey.current = key;
    sessionStorage.setItem(storageKey, key);
    const payload: Payload = {
      requestKey: key,
      amount: String(data.get('amount') || '').trim(),
      currency: 'USDT', method,
      blockchain: method === 'BLOCKCHAIN'
        ? String(data.get('blockchain')) as 'BSC' | 'ARBITRUM' : null,
      payoutAccount: String(data.get('payoutAccount') || '').trim(),
    };
    pendingPayload.current = payload;
    form.reset();
    void submit(payload);
  }

  function startNew() {
    requestKey.current = null;
    pendingPayload.current = null;
    sessionStorage.removeItem(storageKey);
    setResult(null);
    setUnknown(false);
    setMessage('');
  }

  return <section className="rounded-xl border bg-white p-8 dark:border-gray-700 dark:bg-gray-900">
    <h2 className="text-xl font-semibold">{t('title')}</h2>
    <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
      {t('limits', { available, minimum })}
    </p>
    {result ? <div className="mt-5 space-y-3 text-sm">
        <p role="status" aria-live="polite">{t(result.status === 'submitted' ? 'submitted'
          : result.status === 'rejected' ? 'rejected'
          : result.status === 'manual_review' ? 'manualReview' : 'confirming')}</p>
        <p>{result.amount} {result.currency} · {result.accountMask}</p>
        <p className="break-all text-gray-600 dark:text-gray-300">{t('requestId', { id: result.id })}</p>
        {result.errorCode && <p>{t(result.errorCode === 'INSUFFICIENT_BALANCE' ? 'insufficient'
          : result.errorCode === 'BELOW_MINIMUM' ? 'belowMinimum' : 'providerRejected')}</p>}
        {['submitted', 'rejected'].includes(result.status) &&
          <button type="button" onClick={startNew} className="min-h-11 rounded-lg border px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-600 dark:border-gray-600 dark:focus-visible:outline-gray-300">{t('newRequest')}</button>}
      </div> : unknown ? <div className="mt-5 space-y-3 text-sm">
        <p role="status" aria-live="polite">{message || t('resultUnknown')}</p>
        {requestKey.current && <button type="button" disabled={busy}
          onClick={() => void checkSavedRequest(requestKey.current!)}
          className="min-h-11 rounded-lg border px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-600 disabled:opacity-50 dark:border-gray-600 dark:focus-visible:outline-gray-300">{t('checkStatus')}</button>}
        {pendingPayload.current && <button type="button" disabled={busy}
          onClick={() => void submit(pendingPayload.current!)}
          className="min-h-11 rounded-lg border px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-600 disabled:opacity-50 dark:border-gray-600 dark:focus-visible:outline-gray-300">{t('retrySame')}</button>}
      </div> : disabledReason ? <p className="mt-4 text-sm text-amber-800 dark:text-amber-300">{disabledReason}</p>
      : <form onSubmit={onSubmit} className="mt-5 grid gap-4 sm:max-w-md">
        <label className="text-sm">{t('amount')}
          <input name="amount" type="text" inputMode="decimal" required
            pattern="(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?" autoComplete="off"
            className="mt-2 min-h-11 w-full rounded-lg border p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:focus-visible:outline-gray-300" />
        </label>
        <fieldset>
          <legend className="text-sm">{t('method')}</legend>
          {/* Two payout rails, chosen as cards rather than a dropdown: the same
              choice AutoTrading offers, and each card can name the account it
              expects before the field is filled in. */}
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <button type="button" onClick={() => setMethod('BINANCE_UID')}
              aria-pressed={method === 'BINANCE_UID'}
              className={`min-h-11 rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-600 dark:focus-visible:outline-gray-300 ${method === 'BINANCE_UID' ? 'border-gray-900 bg-gray-50 dark:border-white dark:bg-gray-800' : 'dark:border-gray-600'}`}>
              <span className="block font-medium">Binance UID</span>
              <span className="mt-1 block text-xs text-gray-600 dark:text-gray-300">{t('uidHint')}</span>
            </button>
            <button type="button" onClick={() => setMethod('BLOCKCHAIN')}
              aria-pressed={method === 'BLOCKCHAIN'}
              className={`min-h-11 rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-600 dark:focus-visible:outline-gray-300 ${method === 'BLOCKCHAIN' ? 'border-gray-900 bg-gray-50 dark:border-white dark:bg-gray-800' : 'dark:border-gray-600'}`}>
              <span className="block font-medium">{t('blockchain')}</span>
              <span className="mt-1 block text-xs text-gray-600 dark:text-gray-300">{t('addressHint')}</span>
            </button>
          </div>
        </fieldset>
        {method === 'BLOCKCHAIN' && <label className="text-sm">{t('network')}
          <select name="blockchain" className="mt-2 min-h-11 w-full rounded-lg border p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:focus-visible:outline-gray-300">
            <option value="BSC">BSC</option><option value="ARBITRUM">Arbitrum</option>
          </select>
        </label>}
        <label className="text-sm">{method === 'BINANCE_UID' ? t('uid') : t('address')}
          {/* The patterns mirror the server rules in withdrawal-intent.ts, so a
              typo is caught before a request is filed rather than after. */}
          <input name="payoutAccount" type="text" required autoComplete="off"
            inputMode={method === 'BINANCE_UID' ? 'numeric' : 'text'}
            maxLength={method === 'BINANCE_UID' ? 20 : 42}
            pattern={method === 'BINANCE_UID' ? '[0-9]{5,20}' : '0x[0-9a-fA-F]{40}'}
            className="mt-2 min-h-11 w-full rounded-lg border p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:focus-visible:outline-gray-300" />
        </label>
        {message && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{message}</p>}
        <button type="submit" disabled={busy}
          className="min-h-11 rounded-lg bg-gray-900 px-5 py-3 text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gray-600 disabled:opacity-50 dark:bg-white dark:text-gray-950 dark:focus-visible:outline-gray-300">
          {busy ? t('submitting') : t('submit')}
        </button>
      </form>}
  </section>;
}
