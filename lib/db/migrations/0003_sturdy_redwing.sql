CREATE TYPE "public"."email_outbox_status" AS ENUM('pending', 'processing', 'succeeded', 'dead_letter', 'superseded');--> statement-breakpoint
CREATE TABLE "email_contact_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_version" integer NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"status" "email_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp,
	"last_error_code" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "preferred_locale" text DEFAULT 'en';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "locale_source" text DEFAULT 'fallback';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "marketing_opt_in_requested" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "email_contact_outbox" ADD CONSTRAINT "email_contact_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_contact_outbox_user_version_unique" ON "email_contact_outbox" USING btree ("user_id","event_version");--> statement-breakpoint
CREATE INDEX "email_contact_outbox_claim_idx" ON "email_contact_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "email_contact_outbox_user_idx" ON "email_contact_outbox" USING btree ("user_id","id");
--> statement-breakpoint
CREATE FUNCTION enqueue_email_contact_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.email IS NOT DISTINCT FROM NEW.email
     AND OLD.name IS NOT DISTINCT FROM NEW.name
     AND OLD.email_verified IS NOT DISTINCT FROM NEW.email_verified
     AND OLD.preferred_locale IS NOT DISTINCT FROM NEW.preferred_locale
     AND OLD.locale_source IS NOT DISTINCT FROM NEW.locale_source
     AND OLD.marketing_opt_in_requested IS NOT DISTINCT FROM NEW.marketing_opt_in_requested THEN
    RETURN NEW;
  END IF;

  INSERT INTO email_contact_outbox (user_id, event_version, occurred_at)
  VALUES (
    NEW.id,
    (SELECT COALESCE(MAX(event_version), 0) + 1 FROM email_contact_outbox WHERE user_id = NEW.id),
    clock_timestamp()
  );
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_email_contact_insert AFTER INSERT ON "user"
FOR EACH ROW EXECUTE FUNCTION enqueue_email_contact_change();
--> statement-breakpoint
CREATE TRIGGER user_email_contact_update
AFTER UPDATE OF email, name, email_verified, preferred_locale, locale_source, marketing_opt_in_requested ON "user"
FOR EACH ROW EXECUTE FUNCTION enqueue_email_contact_change();
--> statement-breakpoint
INSERT INTO email_contact_outbox (user_id, event_version, occurred_at)
SELECT id, 1, created_at FROM "user" ON CONFLICT DO NOTHING;
