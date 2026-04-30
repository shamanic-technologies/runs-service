CREATE TABLE IF NOT EXISTS "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"service" text NOT NULL,
	"event" text NOT NULL,
	"detail" text,
	"level" text DEFAULT 'info' NOT NULL,
	"data" jsonb,
	"org_id" uuid,
	"user_id" uuid,
	"brand_ids" text,
	"campaign_id" uuid,
	"workflow_slug" text,
	"feature_slug" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_run_events_run_created" ON "run_events" USING btree ("run_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_run_events_service_created" ON "run_events" USING btree ("service","created_at");
