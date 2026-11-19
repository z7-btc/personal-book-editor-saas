DROP INDEX "email_contact_outbox_one_processing_per_user";--> statement-breakpoint
ALTER TABLE "email_contact_outbox" ADD COLUMN "last_reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_contact_outbox" ADD COLUMN "reconcile_after" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "email_contact_outbox" ADD COLUMN "last_reconcile_code" text;--> statement-breakpoint
ALTER TABLE "email_contact_outbox" ADD COLUMN "reconcile_lease_owner" text;--> statement-breakpoint
ALTER TABLE "email_contact_outbox" ADD COLUMN "reconcile_lease_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "email_contact_outbox_one_active_per_user" ON "email_contact_outbox" USING btree ("user_id") WHERE "email_contact_outbox"."status" = 'processing' OR "email_contact_outbox"."reconcile_lease_owner" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "email_contact_outbox_reconcile_idx" ON "email_contact_outbox" USING btree ("reconcile_after");