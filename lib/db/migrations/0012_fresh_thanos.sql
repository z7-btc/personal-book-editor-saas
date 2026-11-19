CREATE TABLE "commission_grant_preparations" (
	"intent_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"center_order_id" text NOT NULL,
	"spend_id" text NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_grant_preparations_status_check" CHECK ("commission_grant_preparations"."status" IN ('prepared', 'confirmed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "commission_grant_preparations" ADD CONSTRAINT "commission_grant_preparations_intent_id_payment_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_grant_preparations" ADD CONSTRAINT "commission_grant_preparations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commission_grant_preparations_order_unique" ON "commission_grant_preparations" USING btree ("center_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_grant_preparations_spend_unique" ON "commission_grant_preparations" USING btree ("spend_id");--> statement-breakpoint
CREATE INDEX "commission_grant_preparations_workspace_idx" ON "commission_grant_preparations" USING btree ("organization_id","status");