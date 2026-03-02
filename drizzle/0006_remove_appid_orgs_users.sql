ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_organization_id_organizations_id_fk";--> statement-breakpoint
DROP TABLE IF EXISTS "users";--> statement-breakpoint
DROP TABLE IF EXISTS "organizations";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN IF EXISTS "app_id";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_runs_app";
