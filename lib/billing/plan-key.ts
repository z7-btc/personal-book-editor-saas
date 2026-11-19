import { z } from 'zod';

const planKeySchema = z.string().regex(
  /^[a-z0-9_-]{1,120}:(?:one_time|month|year):[A-Z]{3,10}$/,
);

export function parsePlanKey(value: unknown) {
  const [productCode, priceInterval, currency] = planKeySchema.parse(value).split(':');
  return { productCode,
    priceInterval: z.enum(['one_time', 'month', 'year']).parse(priceInterval),
    currency };
}

export function formatPlanKey(productCode: string, interval: string, currency: string) {
  const key = `${productCode}:${interval}:${currency}`;
  return planKeySchema.parse(key);
}
