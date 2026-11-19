-- postgres.js parsed legacy naive dates in the old Node runner's time zone.
-- Default to the old DB zone (the local runner uses the same zone); when they
-- differed, set saas.legacy_email_runner_timezone on the migration connection.
-- Keep attempted events' original wire timestamps and idempotency hashes.
ALTER TABLE "email_contact_outbox" ALTER COLUMN "occurred_at" SET DATA TYPE timestamp with time zone
  USING CASE WHEN attempt_count > 0 THEN occurred_at AT TIME ZONE
      COALESCE(NULLIF(current_setting('saas.legacy_email_runner_timezone', true), ''), current_setting('TimeZone'))
    ELSE occurred_at AT TIME ZONE current_setting('TimeZone') END;--> statement-breakpoint
-- Legacy settle wrote UTC ISO strings; SQL-created/processing rows used now().
ALTER TABLE "email_contact_outbox" ALTER COLUMN "available_at" SET DATA TYPE timestamp with time zone
  USING CASE WHEN attempt_count > 0 AND status <> 'processing' THEN available_at AT TIME ZONE 'UTC'
    ELSE available_at AT TIME ZONE current_setting('TimeZone') END;--> statement-breakpoint
ALTER TABLE "email_contact_outbox" ALTER COLUMN "available_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "email_contact_outbox" ALTER COLUMN "lease_expires_at" SET DATA TYPE timestamp with time zone
  USING lease_expires_at AT TIME ZONE current_setting('TimeZone');--> statement-breakpoint
ALTER TABLE "email_contact_outbox" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone
  USING created_at AT TIME ZONE current_setting('TimeZone');--> statement-breakpoint
ALTER TABLE "email_contact_outbox" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "email_contact_outbox" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone
  USING updated_at AT TIME ZONE current_setting('TimeZone');--> statement-breakpoint
ALTER TABLE "email_contact_outbox" ALTER COLUMN "updated_at" SET DEFAULT now();
