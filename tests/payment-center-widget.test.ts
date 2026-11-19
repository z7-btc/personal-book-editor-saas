import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { CRYPTO_ASSETS, isCryptoAsset } from '@/lib/payment-center/methods';

/**
 * The embedded Payment Center widget surface (plan acceptance criteria 9 and 17).
 *
 * The buyer interface is the centre's remote script, so the host side cannot be
 * rendered under Vitest (the component fetches a public config, injects a
 * cross-origin script and calls `window.PaymentCenter.mount`). What this
 * application still owns is pinned here as assertions over the real sources:
 *
 *  1. the injected script must NOT carry `data-site`, because the centre's own
 *     auto-mount would then render a SECOND widget whose orders never reach our
 *     `payment_intents` bookkeeping;
 *  2. the widget is locked to one catalogue plan AND one interval, and only
 *     mounted after the buyer picks them — an unlocked mount would silently sell
 *     the first catalogue product, and the widget's own plan/interval pickers
 *     are hidden markup we must not depend on;
 *  3. the currency rule: a crypto-priced plan can never be sent to Stripe.
 */

const require_ = createRequire(import.meta.url);
const { readFile } = require_('node:fs/promises') as {
  readFile: (path: URL, encoding: 'utf8') => Promise<string>;
};
const file = (relative: string) => new URL(relative, import.meta.url);
const WIDGET = '../app/[locale]/(dashboard)/pricing/payment-center-widget.tsx';
const PLANS = '../app/[locale]/(dashboard)/pricing/pricing-plans.tsx';
const WINDOW = '../app/[locale]/(dashboard)/pricing/payment-window.tsx';
const PAGE = '../app/[locale]/(dashboard)/pricing/page.tsx';
const CHECKOUT = '../app/api/payment-center/checkout/route.ts';
const CONFIG = '../app/api/payment-center/config/route.ts';
const TOKEN = '../app/api/payment-center/embed-token/route.ts';

describe('the crypto currency rule (AC 17)', () => {
  it('recognises the assets the centre settles on chain, whatever the casing', () => {
    for (const asset of CRYPTO_ASSETS) {
      expect(isCryptoAsset(asset)).toBe(true);
      expect(isCryptoAsset(` ${asset.toLowerCase()} `)).toBe(true);
    }
    for (const fiat of ['USD', 'EUR', 'GBP', 'JPY']) {
      expect(isCryptoAsset(fiat)).toBe(false);
    }
  });
});

describe('the widget host adapter (AC 9)', () => {
  it('injects the remote script without the attributes that auto-mount it', async () => {
    const source = await readFile(file(WIDGET), 'utf8');
    expect(source).toContain('SCRIPT_ATTRIBUTE');
    expect(source).not.toContain("'data-site'");
    expect(source).not.toContain('data-base-url');
    expect(source).not.toContain('data-token-url');
    // The public identifiers travel as explicit mount options instead.
    expect(source).toMatch(/siteCode/);
    expect(source).toMatch(/tokenUrl/);
  });

  it('locks the widget to the buyer\'s plan and interval', async () => {
    const widget = await readFile(file(WIDGET), 'utf8');
    expect(widget).toMatch(/export function PaymentCenterCheckout\(\{ productCode, billingInterval/);
    expect(widget).toMatch(/productCode,/);
    // Without a locked interval the remote script shows its own period picker;
    // passing it is what turns the widget into a plain payment-method list.
    expect(widget).toMatch(/billingInterval,/);
    expect(widget).toMatch(/currency: catalogCurrency,/);

    // The buyer picks plan + interval on the page; only then is the widget
    // mounted, inside the payment window.
    const plans = await readFile(file(PLANS), 'utf8');
    expect(plans).toMatch(/<PaymentCenterCheckout/);
    expect(plans).toMatch(/productCode=\{checkout\.product\.code\}/);
    expect(plans).toMatch(/billingInterval=\{checkout\.price\.interval\}/);
    expect(plans).toMatch(/<PaymentWindow/);

    // The server page no longer renders a widget per card: no per-price
    // currency or method selector may come back, because the buyer picks the
    // plan first and the widget owns the payment method.
    const page = await readFile(file(PAGE), 'utf8');
    expect(page).not.toContain('PaymentCenterWidget');
    expect(page).not.toContain('select[id^="method-"]');
    expect(page).not.toContain('select[id^="currency-"]');
  });

  it('keeps the payment window on literal light colours', async () => {
    const shell = await readFile(file(WINDOW), 'utf8');
    // The remote card is always white; the site theme is dark. A theme token
    // here would render white-on-white.
    expect(shell).toContain('bg-white');
    expect(shell).toContain('text-slate-900');
    expect(shell).not.toMatch(/var\(--[a-z-]+\)/);
  });

  it('keeps the website API key on the server and gates the session token', async () => {
    const token = await readFile(file(TOKEN), 'utf8');
    expect(token).toMatch(/auth\.api\.getSession/);
    expect(token).not.toContain('PAYMENT_CENTER_API_KEY');

    const config = await readFile(file(CONFIG), 'utf8');
    expect(config).not.toContain('PAYMENT_CENTER_API_KEY');
    expect(config).not.toContain('PAYMENT_CENTER_CALLBACK_SIGNING_SECRET');
    expect(config).toContain('no-store');
  });

  it('refuses a card checkout for a crypto-priced plan before any order exists', async () => {
    const source = await readFile(file(CHECKOUT), 'utf8');
    expect(source).toMatch(/isCryptoAsset\(body\.catalog_currency\)/);
    expect(source).toContain('payment_option_unavailable');
    expect(source).toMatch(/blockchain/);
    // The buyer's own selection is forwarded to the intent, never the price.
    expect(source).toMatch(/catalog_currency/);
  });
});
