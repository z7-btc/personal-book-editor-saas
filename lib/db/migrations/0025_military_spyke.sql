-- 付款方式不再由本站枚举约束：支付中心目录里带能力卡的渠道就能收。
-- 先把三列从 saas_payment_method 枚举改成纯文本（枚举 → text 可直接赋值转换）。
ALTER TABLE "payment_intents" ALTER COLUMN "method" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "subscription_grants" ALTER COLUMN "payment_method" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "payment_method" SET DATA TYPE text;--> statement-breakpoint

-- 能力卡里的「动作形状」在建单时就记下来：履约、佣金两阶段、订阅续费
-- 都不再靠方法名猜。先加可空列、回填旧数据，再收紧为非空。
ALTER TABLE "payment_intents" ADD COLUMN "payment_action" text;--> statement-breakpoint
UPDATE "payment_intents" SET "payment_action" = CASE "method"
  WHEN 'stripe' THEN 'redirect'
  WHEN 'manual' THEN 'manual'
  WHEN 'commission_balance' THEN 'commission_reserved'
  WHEN 'blockchain' THEN 'blockchain'
  WHEN 'binance_pay' THEN 'binance_pay'
  ELSE 'manual'
END
WHERE "payment_action" IS NULL;--> statement-breakpoint
ALTER TABLE "payment_intents" ALTER COLUMN "payment_action" SET NOT NULL;--> statement-breakpoint

-- 实际结算币种（可能不同于目录标价币种，例如 USD 标价、USDT 1:1 支付）。
-- 已结算的历史订单可以从证据里补出来，历史页的币种匹配就能走新规则。
ALTER TABLE "payment_intents" ADD COLUMN "settlement_currency" text;--> statement-breakpoint
UPDATE "payment_intents" i SET "settlement_currency" = e."currency"
FROM (
  SELECT DISTINCT ON ("intent_id") "intent_id", "currency"
  FROM "payment_evidence"
  ORDER BY "intent_id", "settled_at" DESC
) e
WHERE e."intent_id" = i."id" AND i."settlement_currency" IS NULL;--> statement-breakpoint

DROP TYPE "public"."saas_payment_method";
