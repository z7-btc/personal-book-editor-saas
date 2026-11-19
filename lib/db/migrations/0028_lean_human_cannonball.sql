CREATE TYPE "public"."book_job_kind" AS ENUM('plan', 'rewrite', 'export', 'auto');--> statement-breakpoint
CREATE TYPE "public"."book_job_status" AS ENUM('queued', 'running', 'paused', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."book_status" AS ENUM('ready', 'extracting', 'planning', 'rewriting', 'paused', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "book_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"user_id" text NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "book_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"book_id" text NOT NULL,
	"kind" "book_job_kind" NOT NULL,
	"status" "book_job_status" DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"file_name" text NOT NULL,
	"status" "book_status" DEFAULT 'ready' NOT NULL,
	"total_chapters" integer DEFAULT 0 NOT NULL,
	"processed_chapters" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_exports" ADD CONSTRAINT "book_exports_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_exports" ADD CONSTRAINT "book_exports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_jobs" ADD CONSTRAINT "book_jobs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_exports_book_idx" ON "book_exports" USING btree ("book_id","created_at");--> statement-breakpoint
CREATE INDEX "book_exports_user_idx" ON "book_exports" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "book_jobs_user_created_idx" ON "book_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "book_jobs_status_idx" ON "book_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "book_jobs_book_idx" ON "book_jobs" USING btree ("book_id");--> statement-breakpoint
CREATE UNIQUE INDEX "book_jobs_one_active_per_book" ON "book_jobs" USING btree ("book_id") WHERE status IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "books_user_created_idx" ON "books" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "books_user_status_idx" ON "books" USING btree ("user_id","status");