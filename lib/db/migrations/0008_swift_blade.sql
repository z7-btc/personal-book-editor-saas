ALTER TABLE "payment_intents" ADD COLUMN "submission_lease_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;