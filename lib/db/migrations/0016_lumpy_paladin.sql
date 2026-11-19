CREATE TYPE "public"."referral_withdrawal_status" AS ENUM('pending', 'sending', 'submitted', 'uncertain', 'rejected', 'manual_review');--> statement-breakpoint
CREATE TABLE "referral_withdrawal_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"request_key" text NOT NULL,
	"amount_decimal" text NOT NULL,
	"currency" text DEFAULT 'USDT' NOT NULL,
	"method" text NOT NULL,
	"blockchain" text,
	"account_ciphertext" text NOT NULL,
	"account_key_version" text NOT NULL,
	"account_fingerprint" text NOT NULL,
	"account_mask" text NOT NULL,
	"status" "referral_withdrawal_status" DEFAULT 'pending' NOT NULL,
	"center_withdrawal_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "referral_withdrawal_amount_check" CHECK ("referral_withdrawal_intents"."amount_decimal" ~ '^(0|[1-9][0-9]*)([.][0-9]{1,8})?$' AND "referral_withdrawal_intents"."amount_decimal"::numeric > 0),
	CONSTRAINT "referral_withdrawal_currency_check" CHECK ("referral_withdrawal_intents"."currency" = 'USDT'),
	CONSTRAINT "referral_withdrawal_method_check" CHECK ("referral_withdrawal_intents"."method" IN ('BINANCE_UID', 'BLOCKCHAIN')),
	CONSTRAINT "referral_withdrawal_chain_check" CHECK (("referral_withdrawal_intents"."method" = 'BINANCE_UID' AND "referral_withdrawal_intents"."blockchain" IS NULL) OR
        ("referral_withdrawal_intents"."method" = 'BLOCKCHAIN' AND "referral_withdrawal_intents"."blockchain" IN ('BSC', 'ARBITRUM'))),
	CONSTRAINT "referral_withdrawal_fingerprint_check" CHECK ("referral_withdrawal_intents"."account_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "referral_withdrawal_intents" ADD CONSTRAINT "referral_withdrawal_intents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_withdrawal_user_request_unique" ON "referral_withdrawal_intents" USING btree ("user_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_withdrawal_center_unique" ON "referral_withdrawal_intents" USING btree ("center_withdrawal_id");--> statement-breakpoint
CREATE INDEX "referral_withdrawal_queue_idx" ON "referral_withdrawal_intents" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "referral_withdrawal_user_idx" ON "referral_withdrawal_intents" USING btree ("user_id","created_at");