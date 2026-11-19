CREATE TYPE "public"."payment_intent_status" AS ENUM('pending', 'submitting', 'action_required', 'unknown', 'failed', 'cancelled', 'settled', 'manual_review');--> statement-breakpoint
CREATE TYPE "public"."saas_payment_method" AS ENUM('stripe', 'manual', 'blockchain', 'commission_balance');--> statement-breakpoint
CREATE TABLE "billing_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"external_billing_id" text NOT NULL,
	"original_payer_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"billing_account_id" text NOT NULL,
	"payer_user_id" text NOT NULL,
	"request_key" text NOT NULL,
	"product_code" text NOT NULL,
	"price_interval" text NOT NULL,
	"amount_decimal" text NOT NULL,
	"currency" text NOT NULL,
	"method" "saas_payment_method" NOT NULL,
	"status" "payment_intent_status" DEFAULT 'pending' NOT NULL,
	"external_order_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payment_center_order_id" text,
	"last_error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_organization_unique" ON "billing_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_external_unique" ON "billing_accounts" USING btree ("external_billing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_request_unique" ON "payment_intents" USING btree ("organization_id","payer_user_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_external_order_unique" ON "payment_intents" USING btree ("external_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_idempotency_unique" ON "payment_intents" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_center_order_unique" ON "payment_intents" USING btree ("payment_center_order_id");--> statement-breakpoint
CREATE INDEX "payment_intents_workspace_status_idx" ON "payment_intents" USING btree ("organization_id","status");