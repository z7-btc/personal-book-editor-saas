import 'server-only';
import { z } from 'zod';
import { requireCapability } from '@/lib/config';

/**
 * Payment Center 公开目录。
 *
 * 渠道清单、每种渠道的输入形状与结算规则都由支付中心下发的「能力卡」
 * (`method_capabilities`) 决定。本文件只做两件事：
 *   1. 把目录解析成站点能用的类型（未知字段原样保留，旧站点不会因新字段报错）；
 *   2. 按能力卡统一校验客户选择、推导结算币种（与支付中心 Python 实现同规则）。
 *
 * 站点代码里不再维护「支持哪些付款方式」的名单。目录里带能力卡的渠道就能收。
 */

const priceSchema = z.object({
  interval: z.string().min(1),
  amount: z.number().finite().positive(),
  amount_decimal: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/)
    .refine((value) => /[1-9]/.test(value)),
  currency: z.string().regex(/^[A-Z0-9]{2,12}$/),
});

const inputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  label: z.string().optional(),
  type: z.string().trim().min(1).max(30),
  source: z.string().trim().min(1).max(40).optional(),
  options: z.array(z.string().trim().min(1).max(40)).optional(),
  depends_on: z.string().optional(),
  default: z.string().optional(),
  default_setting: z.string().optional(),
  required: z.boolean().optional(),
  settlement: z.boolean().optional(),
}).passthrough();

const settlementCurrencySchema = z.object({
  mode: z.enum(['catalog', 'fixed', 'input']).default('catalog'),
  field: z.string().optional(),
  setting: z.string().optional(),
  default: z.string().optional(),
}).passthrough();

const settlementSchema = z.object({
  currency: settlementCurrencySchema.default({ mode: 'catalog' }),
  parity_currencies: z.array(z.string().trim().min(1).max(20)).default([]),
  fulfillment: z.string().optional(),
}).passthrough();

export const methodCapabilitySchema = z.object({
  version: z.number().int().optional(),
  display: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    icon: z.string().optional(),
    note: z.string().optional(),
  }).passthrough().optional(),
  action: z.string().trim().min(1).max(40),
  inputs: z.array(inputSchema).default([]),
  settlement: settlementSchema.default({
    currency: { mode: 'catalog' }, parity_currencies: [],
  }),
  test_only: z.boolean().optional(),
}).passthrough();

const blockchainAssetSchema = z.object({
  blockchain: z.string().trim().min(1).max(40),
  tokens: z.array(z.object({
    currency: z.string().trim().min(1).max(20),
  }).passthrough()).default([]),
}).passthrough();

const catalogSchema = z.object({
  website_id: z.uuid(),
  site_code: z.string().min(1),
  site_name: z.string().min(1),
  // The centre owns this list. A new channel it enables must never make the
  // whole catalogue unreadable on an older site build: unknown values are
  // carried through and acted on only through their capability card.
  methods: z.array(z.string().min(1).max(40)),
  method_capabilities: z.record(z.string(), methodCapabilitySchema).default({}),
  unavailable_methods: z.record(z.string(), z.string()).default({}),
  products: z.array(z.object({
    code: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    prices: z.array(priceSchema).min(1),
  })),
  blockchain_assets: z.array(blockchainAssetSchema).default([]),
}).passthrough();

const responseSchema = z.object({
  status: z.literal('success'),
  data: catalogSchema,
});

export type PaymentCatalog = z.infer<typeof catalogSchema>;
export type MethodCapability = z.infer<typeof methodCapabilitySchema>;
export type CapabilityInput = z.infer<typeof inputSchema>;

export class MethodSelectionError extends Error {}

export const LEGACY_METHODS = [
  'stripe', 'manual', 'blockchain', 'commission_balance', 'binance_pay',
] as const;

/**
 * 过渡兜底：支付中心还没升级、目录里没有 `method_capabilities` 时，
 * 让本站继续认识已有的五种渠道。目录一旦带上能力卡，这份表就不再参与，
 * 新渠道完全由能力卡驱动。
 */
const LEGACY_CAPABILITIES: Record<string, MethodCapability> = {
  stripe: {
    action: 'redirect', inputs: [],
    settlement: { currency: { mode: 'catalog' }, parity_currencies: [],
      fulfillment: 'subscription' },
  },
  manual: {
    action: 'manual', inputs: [],
    settlement: { currency: { mode: 'catalog' }, parity_currencies: [],
      fulfillment: 'exact' },
  },
  commission_balance: {
    action: 'commission_reserved', inputs: [],
    settlement: {
      currency: { mode: 'fixed', setting: 'commission_currency', default: 'USDT' },
      parity_currencies: ['USDT', 'USDC'], fulfillment: 'exact',
    },
  },
  blockchain: {
    action: 'blockchain',
    inputs: [
      { name: 'blockchain', label: '网络', type: 'chain', source: 'blockchain_assets',
        required: true, default: 'BSC' },
      { name: 'currency', label: '币种', type: 'select', source: 'chain_tokens',
        depends_on: 'blockchain', required: true, default: 'USDT', settlement: true },
    ],
    settlement: {
      currency: { mode: 'input', field: 'currency', default: 'USDT' },
      parity_currencies: ['USDT', 'USDC'], fulfillment: 'chain_confirmed',
    },
  },
  binance_pay: {
    action: 'binance_pay',
    inputs: [
      { name: 'currency', label: '币种', type: 'select', source: 'options',
        options: ['USDT', 'USDC'], required: true, default: 'USDT', settlement: true },
    ],
    settlement: {
      currency: { mode: 'input', field: 'currency', default: 'USDT' },
      parity_currencies: ['USDT', 'USDC'], fulfillment: 'paid_fields',
    },
  },
};

/** 目录里带能力卡的渠道；支付中心未升级时回退到旧五种。 */
export function methodCapabilities(catalog: PaymentCatalog): Record<string, MethodCapability> {
  const capabilities = catalog.method_capabilities;
  if (capabilities && Object.keys(capabilities).length > 0) return capabilities;
  const fallback: Record<string, MethodCapability> = {};
  for (const method of LEGACY_METHODS) {
    if (catalog.methods.includes(method)) fallback[method] = LEGACY_CAPABILITIES[method];
  }
  return fallback;
}

/** 某渠道的能力卡；没有能力卡 = 本站不展示、不接单。 */
export function methodCapability(catalog: PaymentCatalog,
  method: string): MethodCapability | null {
  return methodCapabilities(catalog)[method] ?? null;
}

/** 目录里真正能收款的渠道（有开关、有能力卡、未被标记不可用）。 */
export function enabledMethods(catalog: PaymentCatalog): string[] {
  const capabilities = methodCapabilities(catalog);
  return catalog.methods.filter((method) =>
    Boolean(capabilities[method]) && !catalog.unavailable_methods[method]);
}

function catalogSetting(catalog: PaymentCatalog, key: string): string | undefined {
  const value = (catalog as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function assetChains(catalog: PaymentCatalog) {
  return catalog.blockchain_assets
    .map((asset) => ({ blockchain: asset.blockchain.toUpperCase(), asset }))
    .filter((item) => item.blockchain);
}

/**
 * 按能力卡读取并校验客户选择。兼容两种提交形状：
 * 新站点放在 `inputs` 对象里，老站点直接平铺 `currency` / `blockchain`。
 * 返回的键和值与能力卡里的 `name` 一致。
 */
export function capabilityInputs(capability: MethodCapability,
  selection: Record<string, unknown> = {},
  catalog: PaymentCatalog): Record<string, string> {
  const supplied = selection.inputs && typeof selection.inputs === 'object'
    ? selection.inputs as Record<string, unknown> : {};
  const values: Record<string, string> = {};
  for (const spec of capability.inputs) {
    let value: unknown = supplied[spec.name];
    if (value === undefined || value === null || value === '') value = selection[spec.name];
    if ((value === undefined || value === null || value === '') && spec.default_setting) {
      value = catalogSetting(catalog, spec.default_setting);
    }
    if (value === undefined || value === null || value === '') value = spec.default;
    if ((value === undefined || value === null || value === '') &&
        spec.type === 'chain' && catalog.blockchain_assets.length > 0) {
      value = catalog.blockchain_assets[0].blockchain;
    }
    let text = typeof value === 'string' ? value.trim() : '';
    if (text.length > 80) throw new MethodSelectionError('付款选项过长');
    if (!text) {
      if (spec.required) {
        throw new MethodSelectionError(`请选择${spec.label || spec.name}`);
      }
      continue;
    }
    if (spec.source === 'options') {
      const allowed = (spec.options || []).map((item) => item.trim().toUpperCase());
      if (allowed.length > 0 && !allowed.includes(text.toUpperCase())) {
        throw new MethodSelectionError(
          `${spec.label || spec.name}只能是 ${allowed.join('、')}`);
      }
      text = text.toUpperCase();
    } else if (spec.source === 'blockchain_assets') {
      const allowed = assetChains(catalog).map((item) => item.blockchain);
      if (allowed.length > 0 && !allowed.includes(text.toUpperCase())) {
        throw new MethodSelectionError(`不支持的${spec.label || spec.name}: ${text}`);
      }
      text = text.toUpperCase();
    } else if (spec.source === 'chain_tokens') {
      const chainCode = (values[spec.depends_on || ''] || '').toUpperCase();
      const chain = assetChains(catalog)
        .find((item) => item.blockchain === chainCode)?.asset;
      const tokens = new Set((chain?.tokens || [])
        .map((token) => token.currency.toUpperCase()));
      if (tokens.size > 0 && !tokens.has(text.toUpperCase())) {
        throw new MethodSelectionError(`${chainCode} 上不支持 ${text} 这种代币`);
      }
      text = text.toUpperCase();
    }
    values[spec.name] = text;
  }
  return values;
}

/** 能力卡声明的结算币种：catalog / fixed（站点设置）/ input（客户选的）。 */
export function settlementCurrencyFor(capability: MethodCapability,
  values: Record<string, string>, catalog: PaymentCatalog,
  catalogCurrency: string): string {
  const spec = capability.settlement.currency;
  const fallback = String(catalogCurrency || '').toUpperCase();
  if (spec.mode === 'fixed') {
    const fixed = spec.setting ? catalogSetting(catalog, spec.setting) : undefined;
    return String(fixed || spec.default || fallback).trim().toUpperCase();
  }
  if (spec.mode === 'input') {
    const selected = values[spec.field || ''] || spec.default;
    return String(selected || fallback).trim().toUpperCase();
  }
  return fallback;
}

/**
 * 商品定价与结算币种必须能对上：同币种永远可以；美元定价按 1:1 接受能力卡
 * 声明的稳定币。其他组合必须先给这个币种配置价格，不能悄悄按汇率乱算。
 */
export function assertCurrencyPayable(capability: MethodCapability,
  selected: string, catalogCurrency: string) {
  const wanted = String(selected || '').toUpperCase();
  const catalog = String(catalogCurrency || '').toUpperCase();
  if (wanted === catalog) return;
  const parity = capability.settlement.parity_currencies
    .map((item) => item.trim().toUpperCase());
  if (catalog === 'USD' && parity.includes(wanted)) return;
  throw new MethodSelectionError('该币种没有配置对应价格，不能直接换成另一种币付款');
}

/** 能力卡里声明的链字段的值（老接口需要平铺的 blockchain）。 */
export function chainInput(capability: MethodCapability,
  values: Record<string, string>): string | undefined {
  const spec = capability.inputs.find((input) => input.type === 'chain');
  return spec ? values[spec.name] || undefined : undefined;
}

export type MethodSelection = {
  method: string;
  capability: MethodCapability;
  inputs: Record<string, string>;
  currency: string;
  blockchain?: string;
};

/**
 * 「渠道 + 客户选择 → 输入、结算币种、平铺链」的唯一解析入口。
 * 返回 null 表示目录里没有这个渠道的能力卡（本站不接单）。
 */
export function resolveMethodSelection(catalog: PaymentCatalog, method: string,
  selection: Record<string, unknown> = {}, catalogCurrency = 'USD'): MethodSelection | null {
  const capability = methodCapability(catalog, method);
  if (!capability) return null;
  const inputs = capabilityInputs(capability, selection, catalog);
  const currency = settlementCurrencyFor(capability, inputs, catalog, catalogCurrency);
  assertCurrencyPayable(capability, currency, catalogCurrency);
  return { method, capability, inputs, currency, blockchain: chainInput(capability, inputs) };
}

export async function getPaymentCatalog(send: typeof fetch = fetch): Promise<PaymentCatalog> {
  requireCapability('paymentCenter');
  const endpoint = new URL('/api/payment-center/catalog', process.env.PAYMENT_CENTER_BASE_URL);
  if (process.env.NODE_ENV === 'production' && endpoint.protocol !== 'https:') {
    throw new Error('Payment Center URL must use HTTPS in production');
  }
  const response = await send(endpoint, {
    headers: { 'X-API-Key': process.env.PAYMENT_CENTER_API_KEY! },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Payment Center catalog returned HTTP ${response.status}`);
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Payment Center catalog response is invalid');
  const catalog = parsed.data.data;
  if (process.env.PAYMENT_CENTER_SITE_CODE &&
      catalog.site_code !== process.env.PAYMENT_CENTER_SITE_CODE) {
    throw new Error('Payment Center catalog belongs to a different website');
  }
  if (process.env.PAYMENT_CENTER_WEBSITE_ID &&
      catalog.website_id !== process.env.PAYMENT_CENTER_WEBSITE_ID) {
    throw new Error('Payment Center catalog has an unexpected website ID');
  }
  return catalog;
}
