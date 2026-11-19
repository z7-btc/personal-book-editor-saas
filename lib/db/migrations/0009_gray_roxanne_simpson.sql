CREATE TYPE "public"."payment_inbox_status" AS ENUM('pending', 'quarantined', 'manual_review', 'processed');--> statement-breakpoint
CREATE TABLE "payment_inbox" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"center_order_id" text NOT NULL,
	"external_order_id" text NOT NULL,
	"website_id" text NOT NULL,
	"body_sha256" text NOT NULL,
	"status" "payment_inbox_status" NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_inbox_body_hash_check" CHECK ("payment_inbox"."body_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "payment_inbox_status_received_idx" ON "payment_inbox" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "payment_inbox_external_order_idx" ON "payment_inbox" USING btree ("external_order_id");