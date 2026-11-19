import 'server-only';

export type PlanKeyParts = {
  productCode: string;
  priceInterval: 'one_time' | 'month' | 'year';
  currency: string;
};

const PLAN_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}:(one_time|month|year):[A-Z]{3,10}$/;

/**
 * Splits the `productCode:interval:currency` key the billing surface uses.
 * Returns null for anything that is not exactly that shape, so a caller cannot
 * smuggle a plan change through a malformed key.
 */
export function planKeyParts(value: string): PlanKeyParts | null {
  if (!PLAN_KEY_PATTERN.test(value)) return null;
  const [productCode, priceInterval, currency] = value.split(':');
  return {
    productCode: productCode!,
    priceInterval: priceInterval as PlanKeyParts['priceInterval'],
    currency: currency!,
  };
}

export function formatPlanKey(parts: PlanKeyParts): string {
  return `${parts.productCode}:${parts.priceInterval}:${parts.currency}`;
}
