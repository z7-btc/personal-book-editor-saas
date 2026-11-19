import { z } from 'zod';

// Channel names come from the Payment Center catalogue, which may add one
// without this build changing. Refusing an unknown name would hide a real
// settled payment from the buyer's history.
const method = z.string().min(1).max(40);
const amount = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/);
const currency = z.string().regex(/^[A-Z]{3,10}$/);
const identifier = z.string().min(1).max(180);
const instant = z.iso.datetime();
const page = <T extends z.ZodType>(item: T) => z.object({
  items: z.array(item).max(25), nextCursor: z.string().max(512).nullable(),
}).strict();

export const billingOrderSchema = z.object({
  id: identifier, productCode: z.string().min(1).max(180),
  interval: z.enum(['month', 'year']), method,
  status: z.enum(['pending', 'submitting', 'action_required', 'unknown', 'failed',
    'cancelled', 'manual_review', 'awaiting_confirmation', 'settled']),
  amountDecimal: amount, currency, recordedAt: instant, hasVerifiedPayment: z.boolean(),
}).strict();

export const billingPaymentSchema = z.object({
  id: identifier, orderId: identifier, productCode: z.string().min(1).max(180), method,
  amountDecimal: amount, currency, settledAt: instant, periodStart: instant, periodEnd: instant,
  status: z.enum(['settled', 'refunded', 'disputed', 'reversed']),
  access: z.enum(['active', 'upcoming', 'expired', 'revoked', 'review']),
}).strict();

export const billingHistorySchema = z.object({
  asOf: instant, paymentEnabled: z.boolean(),
  subscription: z.object({
    state: z.enum(['active', 'none']), productCode: z.string().nullable(),
    method: method.nullable(), periodStart: instant.nullable(), periodEnd: instant.nullable(),
  }).strict(),
  orders: page(billingOrderSchema), payments: page(billingPaymentSchema),
}).strict();

export type BillingHistory = z.infer<typeof billingHistorySchema>;
export type BillingOrder = z.infer<typeof billingOrderSchema>;
export type BillingPayment = z.infer<typeof billingPaymentSchema>;
export type BillingHistorySection = 'all' | 'orders' | 'payments';

export const billingHistoryQuerySchema = z.object({
  section: z.enum(['all', 'orders', 'payments']).default('all'),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.string().regex(/^(?:[1-9]|1\d|2[0-5])$/).transform(Number).default(10),
}).strict().refine((value) => !value.cursor || value.section !== 'all');
