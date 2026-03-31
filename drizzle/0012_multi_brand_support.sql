-- Migrate brand_id (single text) to brand_ids (text array) for multi-brand support
ALTER TABLE "runs" ADD COLUMN "brand_ids" text[];

-- Migrate existing data: wrap single brand_id into an array
UPDATE "runs" SET "brand_ids" = ARRAY["brand_id"] WHERE "brand_id" IS NOT NULL;

-- Drop old column and index
DROP INDEX IF EXISTS "idx_runs_brand";
ALTER TABLE "runs" DROP COLUMN "brand_id";

-- Create GIN index for efficient array queries
CREATE INDEX "idx_runs_brand_ids" ON "runs" USING gin ("brand_ids");
