CREATE TYPE "public"."referral_sync_status" AS ENUM('pending', 'processing', 'succeeded', 'dead_letter', 'superseded');--> statement-breakpoint
CREATE TABLE "referral_attributions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"inviter_user_id" text NOT NULL,
	"invite_code" text NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_attributions_not_self_check" CHECK ("referral_attributions"."user_id" <> "referral_attributions"."inviter_user_id")
);
--> statement-breakpoint
CREATE TABLE "referral_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"invite_code" text NOT NULL,
	"sync_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_profiles_sync_version_check" CHECK ("referral_profiles"."sync_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "referral_user_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_version" integer NOT NULL,
	"status" "referral_sync_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_profiles" ADD CONSTRAINT "referral_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_user_outbox" ADD CONSTRAINT "referral_user_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referral_attributions_inviter_idx" ON "referral_attributions" USING btree ("inviter_user_id","bound_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_profiles_invite_code_unique" ON "referral_profiles" USING btree ("invite_code");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_user_outbox_user_version_unique" ON "referral_user_outbox" USING btree ("user_id","event_version");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_user_outbox_one_processing_per_user" ON "referral_user_outbox" USING btree ("user_id") WHERE "referral_user_outbox"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "referral_user_outbox_claim_idx" ON "referral_user_outbox" USING btree ("status","available_at");
--> statement-breakpoint
CREATE FUNCTION create_referral_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO referral_profiles (user_id, invite_code)
  VALUES (NEW.id, 'SF' || upper(replace(gen_random_uuid()::text, '-', '')))
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_referral_profile_insert AFTER INSERT ON "user"
FOR EACH ROW EXECUTE FUNCTION create_referral_profile();
--> statement-breakpoint
CREATE FUNCTION enqueue_referral_profile_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO referral_user_outbox (user_id, event_version)
  VALUES (NEW.user_id, NEW.sync_version);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER referral_profile_outbox_insert AFTER INSERT ON referral_profiles
FOR EACH ROW EXECUTE FUNCTION enqueue_referral_profile_insert();
--> statement-breakpoint
CREATE FUNCTION enqueue_referral_profile_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_version integer;
BEGIN
  IF TG_TABLE_NAME = 'user' AND
     OLD.name IS NOT DISTINCT FROM NEW.name AND
     OLD.email IS NOT DISTINCT FROM NEW.email THEN
    RETURN NEW;
  END IF;
  UPDATE referral_profiles
  SET sync_version = sync_version + 1
  WHERE user_id = NEW.id
  RETURNING sync_version INTO next_version;
  IF FOUND THEN
    INSERT INTO referral_user_outbox (user_id, event_version)
    VALUES (NEW.id, next_version);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_referral_profile_update
AFTER UPDATE OF name, email ON "user"
FOR EACH ROW EXECUTE FUNCTION enqueue_referral_profile_change();
--> statement-breakpoint
CREATE FUNCTION enqueue_referral_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_version integer;
BEGIN
  UPDATE referral_profiles
  SET sync_version = sync_version + 1
  WHERE user_id = NEW.user_id
  RETURNING sync_version INTO next_version;
  INSERT INTO referral_user_outbox (user_id, event_version)
  VALUES (NEW.user_id, next_version);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER referral_attribution_outbox_insert AFTER INSERT ON referral_attributions
FOR EACH ROW EXECUTE FUNCTION enqueue_referral_attribution();
--> statement-breakpoint
CREATE FUNCTION prevent_referral_attribution_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'referral attribution is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER referral_attribution_no_update BEFORE UPDATE ON referral_attributions
FOR EACH ROW EXECUTE FUNCTION prevent_referral_attribution_update();
--> statement-breakpoint
INSERT INTO referral_profiles (user_id, invite_code)
SELECT id, 'SF' || upper(replace(gen_random_uuid()::text, '-', ''))
FROM "user" ON CONFLICT (user_id) DO NOTHING;
