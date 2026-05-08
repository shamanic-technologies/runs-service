# Project: runs-service

REST API for tracking service execution runs and their associated costs, with hierarchical parent-child runs and cost aggregation.

## Commands

- `npm run dev` — local dev server with hot reload
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm run generate:openapi` — regenerate openapi.json only
- `npm run start` — production server
- `npm test` — run all tests
- `npm run test:unit` — unit tests only
- `npm run test:integration` — integration tests (needs DB)
- `npm run db:generate` — generate Drizzle migrations
- `npm run db:migrate` — apply migrations
- `npm run db:push` — push schema directly to DB
- `npm run db:studio` — open Drizzle Studio

## Architecture

- `src/schemas.ts` — Zod schemas (source of truth for validation + OpenAPI)
- `src/routes/runs.ts` — CRUD routes for runs and costs
- `src/routes/health.ts` — Health check endpoint
- `src/middleware/auth.ts` — API key authentication middleware
- `src/services/cost-resolver.ts` — Resolves unit costs from costs-service
- `src/services/billing.ts` — billing-service client (`deductCredits`, `provisionCredits`, `confirmProvision`, `cancelProvision`)
- `src/db/schema.ts` — Drizzle ORM schema (organizations, users, runs, runs_costs)
- `src/db/index.ts` — Database connection
- `src/index.ts` — Express app setup and server entry point
- `tests/unit/` — Unit tests
- `tests/integration/` — Integration tests (supertest)
- `openapi.json` — Auto-generated, do NOT edit manually

## Cost & billing precision

- `runs_costs.total_cost_in_usd_cents` is `numeric(16,10)` — fractional cents, do NOT round.
- runs-service passes raw fractional amounts to billing-service (`deductCredits` / `provisionCredits` / `confirmProvision`). billing-service ledger stores fractional too. **Never reintroduce `Math.ceil` / `Math.round` / `Math.floor` on cost values** — per-batch rounding caused the 5.5× over-billing incident (window 2026-04-30 → 2026-05-04).
- Only `cost_source='platform'` rows are billed. `cost_source='org'` is BYOK tracking — no billing call.

## Deploy ordering with billing-service

Any change to runs-service's billing call shape (amount type/precision, headers, endpoint path) MUST land in billing-service first and deploy to the target env before the runs-service PR merges. Squash-merge to `staging` triggers Railway auto-deploy; merging ahead of billing-service breaks the env. Document the upstream dependency in the PR body under `⚠️ Deployment ordering` and defer merge until billing-service is live in the same env.

## Build verification gap

CI runs vitest only — `npm run build` (i.e. `tsc`) is NOT in the test workflows. TypeScript-only failures (e.g. drizzle's `PgSelectBase` type narrowing on conditional `.limit()` chains) ship through green CI and break Railway. Until CI runs `npm run build`, run it locally before merging anything that:

- changes a drizzle query builder (`.where`, `.limit`, `.offset`, `.orderBy` reassignments)
- changes Zod schema generics consumed by the OpenAPI generator
- adds/removes route handlers wired in `src/index.ts`

The v0.21.1 hotfix exists because a `let query = …; query = query.limit(limit)` pattern passed CI and failed Railway TS build.
