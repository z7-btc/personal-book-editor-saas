CREATE TABLE "payment_handshake_challenges" (
	"check_id" text PRIMARY KEY NOT NULL,
	"site_code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_handshake_challenges_id_check" CHECK ("payment_handshake_challenges"."check_id" ~ '^[0-9a-f]{32}$')
);
--> statement-breakpoint
CREATE INDEX "payment_handshake_challenges_expires_idx" ON "payment_handshake_challenges" USING btree ("expires_at");