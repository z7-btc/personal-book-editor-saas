CREATE TABLE "rateLimit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rateLimit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
-- Updating the canonical address invalidates all old sessions in the same
-- transaction as the address and contact-outbox change. No cookie written by
-- an in-flight verification request can preserve an old session afterwards.
CREATE FUNCTION revoke_sessions_on_email_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "session" WHERE user_id = NEW.id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_email_change_sessions
AFTER UPDATE OF email ON "user"
FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email)
EXECUTE FUNCTION revoke_sessions_on_email_change();
