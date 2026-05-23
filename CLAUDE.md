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
- `src/services/billing.ts` — billing-service client. `notifyUsage` only — fire-and-forget cache-invalidation hint after each `runs_costs` write. Failures log to Railway; lifecycle never blocks. Truth lives in `GET /internal/org-usage-total` (billing-service re-reads on every authorize).
- `src/db/schema.ts` — Drizzle ORM schema (organizations, users, runs, runs_costs)
- `src/db/index.ts` — Database connection
- `src/index.ts` — Express app setup and server entry point
- `tests/unit/` — Unit tests
- `tests/integration/` — Integration tests (supertest)
- `openapi.json` — Auto-generated, do NOT edit manually

## Cost & billing precision

- `runs_costs.total_cost_in_usd_cents` is `numeric(16,10)` — fractional cents, do NOT round.
- runs-service no longer calls billing-service for run-level deduct/provision/confirm/cancel — `runs_costs` is the source of truth, billing-service re-derives via `GET /internal/org-usage-total`. **Never reintroduce `Math.ceil` / `Math.round` / `Math.floor` on cost values** — per-batch rounding caused the 5.5× over-billing incident (window 2026-04-30 → 2026-05-04).
- Only `cost_source='platform'` rows count toward billing. `cost_source='org'` is BYOK tracking — excluded from `/internal/org-usage-total` and from `notifyUsage` `spent_total_cents`.
- **Never use `Number(x)` on a cost-value string**, even inside `Number(x).toFixed(10)`. IEEE 754 double has ~15-17 sig digits; `numeric(16,10)` max value `999999.9999999999` has 16 → round-trip drops digits, and SUM of many rows compounds float drift. Use `new Decimal(x)` from `decimal.js` for any JS arithmetic on cost values; convert to `number` ONLY at the billing-service boundary (`.toNumber()`), where the upstream API still accepts `number`. For PG aggregations, prefer `SUM(...)::text` and pass the string through unchanged, or wrap in `new Decimal(...).toFixed(10)` for normalized scale.
- For reconciliation/drift-detection endpoints that diff against billing-service totals, run all math in Postgres (CTE + `::text` cast) — handler does zero JS arithmetic so `numeric(16,10)` precision survives byte-for-byte (see `GET /internal/runs-expected-totals`).

## Deploy ordering with billing-service

Any change to runs-service's billing call shape (amount type/precision, headers, endpoint path) MUST land in billing-service first and deploy to the target env before the runs-service PR merges. Squash-merge to `staging` triggers Railway auto-deploy; merging ahead of billing-service breaks the env. Document the upstream dependency in the PR body under `⚠️ Deployment ordering` and defer merge until billing-service is live in the same env.

## Build verification gap

CI runs vitest only — `npm run build` (i.e. `tsc`) is NOT in the test workflows. TypeScript-only failures (e.g. drizzle's `PgSelectBase` type narrowing on conditional `.limit()` chains) ship through green CI and break Railway. Until CI runs `npm run build`, run it locally before merging anything that:

- changes a drizzle query builder (`.where`, `.limit`, `.offset`, `.orderBy` reassignments)
- changes Zod schema generics consumed by the OpenAPI generator
- adds/removes route handlers wired in `src/index.ts`

The v0.21.1 hotfix exists because a `let query = …; query = query.limit(limit)` pattern passed CI and failed Railway TS build.

## Test parallelism (integration tests)

Integration tests run with `fileParallelism: true, maxWorkers: 4` and a 4-way matrix in CI. Three invariants must hold or the suite goes flaky:

- **Org-scoped per-test cleanup, not TRUNCATE.** `cleanTestData(orgIds)` deletes only rows for the given orgs (cascade clears `runs_costs`/`run_events`). Each integration file declares a file-local `ORG_ID` constant. If a test inserts into a *secondary* org (for cross-org isolation assertions), include that secondary org in the cleanup array — pollution there breaks `/public/*` tests on the same shard.
- **`tests/global-setup.ts` runs once per shard and TRUNCATEs all 3 tables.** CI Neon branches are forked from a parent that contains production-scale data (~600k rows). Without this wipe, `/public/stats/*` and `/v1/stats/public/*` assertions count inherited rows.
- **`stats.test.ts` runs on its own shard.** `/public/*` endpoints aggregate across all orgs, so they're immune to org-scoped cleanup. The matrix in `.github/workflows/test.yml` assigns it `name: stats` alone — do not co-locate other files on that shard.

## Idempotency on silver writes (v0.29.1)

`runs.idempotency_key` and `runs_costs.idempotency_key` are caller-supplied dedup keys. Used for webhook redelivery, queue replay, and any retryable upstream caller.

- **Scope:** `runs.idempotency_key` is **global** (single-column partial unique idx, WHERE NOT NULL). Callers MUST self-namespace (`stripe:txn_...`, `workflow:run_...`). `runs_costs.idempotency_key` is **per-run** (`(run_id, idempotency_key)` partial unique idx) — same key may be reused across different runs.
- **Generic, not service-specific.** The field is `idempotencyKey` on every public route — never `externalId`, `stripeBalanceTxnId`, `clientReferenceId`, etc. Callers, not the schema, encode their namespace.
- **Endpoint:** webhook/system callers go through `/v1/platform-runs` + optional `x-org-id` / `x-user-id`. `/v1/runs` keeps its human-user contract (required `x-org-id`). Both routes accept `idempotencyKey`.
- **Replay semantics:** repeat → **200** with existing row; collision with different `(serviceName, taskName)` on the same key → **409**. Cost-item replay → **201** with the original row in the response (no duplicate inserted).
- **Race handler:** insert wrapped in `try { ... } catch (e) { if e.code==='23505' && idempotencyKey) re-fetch }`. Don't remove without understanding why concurrent retries are possible.
- **No notifyUsage on `/v1/platform-runs/:id/costs`.** billing-service's `requireOrgHeaders` middleware still requires `x-user-id` + `x-run-id`, which platform callers may not have. Truth re-derives via `GET /internal/org-usage-total` on next authorize. Relax billing-service first if real-time invalidation becomes a hard requirement.

## Data layering (B/S/G — γ migration plan)

Industry-standard event-sourcing + projection layout per Kleppmann (log = source of truth), Young (domain events, not property sourcing), Richardson (projection cache for fast reads). Migration follows Fowler's expand-contract (γ variant): expand → dual-write → backfill → swap reads → stop legacy writes → rename old → drop.

### Current state — Phase 1 (substrate only)

| Layer | Tables / Views | Status |
|-------|---------------|--------|
| **Bronze** | `run_lifecycle_events`, `cost_lifecycle_events` (migration 0018) | Created. Empty. No handlers write yet. |
| **Silver** | `runs`, `runs_costs`, `run_events` | Unchanged. Still the live write path. Status columns still mutated via `PATCH` handlers. |
| **Gold** | `v_runs_with_descendants`, `v_run_cost_rollup`, `v_org_platform_spend` (migration 0019) | Created. No consumer reads yet. |
| **Semantic predicates** | `runs_costs.is_platform_projected`, `runs_costs.is_platform_committed` (migration 0017) | Generated boolean columns. Indexed. Source of truth for the platform-billable definition. |

### Doctrine

- **Bronze tables are append-only.** No FK to `runs` / `runs_costs` (bronze must survive cascade-deletes). Cross-reference via `run_id` / `cost_id` UUID columns.
- **Domain events, not property sourcing.** Event types: `run.created | run.completed | run.failed | cost.added | cost.materialized | cost.cancelled`. Not `field_updated(field='status')`.
- **Events store delta + reason in `payload`, never the full aggregate** (avoid the "fat event" anti-pattern).
- **All cost math stays in Postgres.** Generated columns + views encode the semantic predicates once. **Never** copy `cost_source='platform' AND status IN ('actual','provisioned')` as an inline literal in new code — use `is_platform_projected` or the view that already does. Same for `cost_source='platform' AND status='actual'` → `is_platform_committed`.
- **Gold views are read-only.** Never INSERT/UPDATE/DELETE through them.
- **Phase 2+ wiring:** every silver write/update will be preceded by a bronze insert in the same transaction. Idempotent replays (the HTTP 200 path) do NOT write bronze — bronze captures state changes, not HTTP traffic.

### Future phases

| Phase | Scope | Contract impact |
|-------|-------|-----------------|
| 1 (this PR) | Bronze tables + generated cols + gold views | None (additive only) |
| 2 | Dual-write — handlers insert into bronze before silver write, same txn | None |
| 3 | Backfill — synthesize historical events for pre-Phase-2 rows | None |
| 4 | Migrate readers — route consumers swap to gold views one by one | None (shapes preserved) |
| 5 | Stop writing silver directly; project current-state via trigger from bronze | None (trigger maintains the cached columns) |
| 6 | `ALTER TABLE runs RENAME TO runs_old` etc. when no writer touches the old shape | None |
| 7 | Drop `_old` tables (manual, days/weeks after Phase 6) | None |

## CI status checks ↔ branch protection

Branch protection on `staging` requires status checks named exactly `test-integration` and `test-unit`. The `test-integration` matrix job produces context names like `test-integration (stats, …)` which do NOT match the required name. A separate aggregator job named `test-integration` (depends on `test-integration-shard`, fails if any shard failed) provides the required context. When changing the matrix structure, keep the aggregator job name intact or PRs will sit in `BLOCKED` despite green shards.
