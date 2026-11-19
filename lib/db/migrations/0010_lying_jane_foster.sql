CREATE TYPE "public"."payment_evidence_status" AS ENUM('settled', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."subscription_grant_status" AS ENUM('active', 'reversed');--> statement-breakpoint
ALTER TYPE "public"."payment_inbox_status" ADD VALUE 'processing' BEFORE 'quarantined';--> statement-breakpoint
CREATE TABLE "payment_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"website_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"intent_id" text NOT NULL,
	"evidence_key" text NOT NULL,
	"source_event_id" text NOT NULL,
	"center_order_id" text NOT NULL,
	"provider_subscription_id" text,
	"provider_invoice_id" text,
	"provider_payment_id" text,
	"amount_decimal" text NOT NULL,
	"currency" text NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"service_period_start" timestamp with time zone NOT NULL,
	"service_period_end" timestamp with time zone NOT NULL,
	"status" "payment_evidence_status" DEFAULT 'settled' NOT NULL,
	"reversed_by_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_evidence_amount_check" CHECK ("payment_evidence"."amount_decimal" ~ '^(0|[1-9][0-9]*)([.][0-9]{1,8})?$' AND "payment_evidence"."amount_decimal"::numeric > 0),
	CONSTRAINT "payment_evidence_period_check" CHECK ("payment_evidence"."service_period_end" > "payment_evidence"."service_period_start")
);
--> statement-breakpoint
CREATE TABLE "subscription_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"product_code" text NOT NULL,
	"payment_method" "saas_payment_method" NOT NULL,
	"provider_subscription_id" text,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" "subscription_grant_status" DEFAULT 'active' NOT NULL,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_grants_period_check" CHECK ("subscription_grants"."period_end" > "subscription_grants"."period_start")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"product_code" text,
	"payment_method" "saas_payment_method",
	"provider_subscription_id" text,
	"status" text DEFAULT 'inactive' NOT NULL,
	"active_until" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" IN ('active', 'inactive'))
);
--> statement-breakpoint
ALTER TABLE "payment_inbox" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_inbox" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_inbox" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_inbox" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_grants" ADD CONSTRAINT "subscription_grants_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_grants" ADD CONSTRAINT "subscription_grants_evidence_id_payment_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."payment_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_evidence_website_key_unique" ON "payment_evidence" USING btree ("website_id","evidence_key");--> statement-breakpoint
CREATE INDEX "payment_evidence_workspace_idx" ON "payment_evidence" USING btree ("organization_id","service_period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_grants_evidence_unique" ON "subscription_grants" USING btree ("evidence_id");--> statement-breakpoint
CREATE INDEX "subscription_grants_workspace_period_idx" ON "subscription_grants" USING btree ("organization_id","period_end");