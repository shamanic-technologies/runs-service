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

## Frozen net (usage-discount) — gross + net on every cost row (migration 0028)

The platform charges a per-org **usage discount** (a fraction, owned by billing-service). It is **FROZEN at cost-write time** on each `runs_costs` row so every reader gets gross OR net with zero recomputation and a later discount change is **non-retroactive** (past rows keep the net actually charged).

- **Two nullable columns on `runs_costs`** (`net_cost_in_usd_cents numeric(16,10)`, `usage_discount_pct numeric(9,8)`). NULL for rows written before the freeze → readers `COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)`, which is the correct semantic (no discount existed then, so net == gross). **No backfill** — a full-table UPDATE on the multi-million-row ledger would block boot (see "Boot-window hazards"). Nullable-add is instant metadata.
- **`total_cost_in_usd_cents` stays GROSS, unchanged.** Every existing gross read returns today's numbers byte-identical. Net is served only where a consumer asks for it: `net_spent_cents` on `GET /internal/org-usage-total` (billing reads it for the spendable balance); `net{Total,Actual,Provisioned}CostInUsdCents` on GET/POST `/v1/stats/costs` (features reads gross or net per-attribution) and per-window on `POST /v1/stats/budget`; and per-group / per-bucket on the public cross-org reads `GET /v1/stats/public/costs` + `GET /v1/stats/public/costs/timeseries` (the fleet-revenue consumer sums `netActual` for post-usage-discount realized revenue). Batch/rollup reads stay gross-only.
- **Freeze happens at write, via the bronze payload.** `POST /v1/runs/:id/costs` + `POST /v1/platform-runs/:id/costs` resolve the org discount once, compute `net = gross × (1 − pct)` in `decimal.js`, and write `netCostInUsdCents` + `usageDiscountPct` into the `cost.added` payload. The `project_cost_lifecycle_to_silver` trigger materializes them (COALESCE net→gross for replay of pre-feature bronze events). Never recompute net on read — that is what makes it non-retroactive.
- **Discount resolution lives in `src/services/usage-discount.ts`** (billing-discount client — kept OUT of `billing.ts` per its "notifyUsage only" note). It reads `GET /internal/accounts/by-org/{orgId}/usage-discount` from billing-service, with a 60s per-org cache. **Fail loud**: billing unreachable/5xx/malformed → `UsageDiscountError` → 502 on the cost write; never silently writes gross-as-net. The only zero-discount cases are: no orgId, or billing 404 (unknown org / no account) → net == gross.
- **Resolution runs UNCONDITIONALLY on every cost write — no env gate.** The prior `USAGE_DISCOUNT_RESOLUTION_ENABLED` rollout flag was removed; resolution is wired always-on in code. Preconditions in prod: `BILLING_SERVICE_URL` + `BILLING_SERVICE_API_KEY` are present on runs-service, and billing-service's `GET /internal/accounts/by-org/{orgId}/usage-discount` (returns `{ discount_pct }`, fraction in [0,1]) is live. An org with a configured discount → rows freeze `net = gross×(1−pct)` + `usage_discount_pct = pct`; an org with none (billing 404) → `net = gross`, `usage_discount_pct = NULL`.

## Denormalized org on cost rows — kill the runs⋈runs_costs join for org-spend (migration 0029)

Org-level platform-spend reads (`GET /internal/org-usage-total`, billing's per-authorize balance re-derive; and the org-spend read in `src/routes/runs.ts`) SUM an org's platform costs. The org lived ONLY on `runs` while the money lives on `runs_costs`, so each read joined `runs JOIN runs_costs` and, for large orgs, ran **two full-table parallel seq-scans + a disk-spilling hash join (~4s, both vCPUs)**. Those two reads were **~71% of all DB time** and the direct cause of prod compute pegging its 2 CU cap (CPU-spike incident 2026-07-25). Same fix family as the frozen-net freeze above and the goal/brand_profile/audience denormalization: the writer already holds the run's org, so persist it, don't re-derive it on every read.

- **One nullable column on `runs_costs`** (`organization_id uuid`) + a **partial covering index** `idx_runs_costs_org_projected ON runs_costs (organization_id) INCLUDE (total_cost_in_usd_cents, net_cost_in_usd_cents) WHERE is_platform_projected`. The org-spend SUM becomes an index scan over only that org's platform-projected rows — no join, no full scan (validated 93ms vs ~4000ms). NULL for pre-feature / pre-backfill rows.
- **Frozen at write from the RUN's org, not the header override.** `POST /v1/runs/:id/costs` + `POST /v1/platform-runs/:id/costs` write `runOrganizationId: run.organizationId` into the `cost.added` payload; the `project_cost_lifecycle_to_silver` trigger materializes it into `organization_id`. Using `run.organizationId` (not `req`/attribution) keeps the de-joined SUM byte-identical to the old runs-join. Org-less platform runs → NULL (org-spend never counts NULL-org rows).
- **EXPAND → BACKFILL → SWAP (mandatory ordering — this is money).** The read swap to the denormalized column must ship in a SEPARATE deploy, AFTER the out-of-band backfill (`scripts/backfill-cost-org.ts`, chunked/idempotent, run manually post-deploy — a full-table UPDATE on the multi-million-row ledger would block boot). A read-swap deployed before backfill completes would read the whale's NULL-org rows as ~0 → **billing over-authorizes**. Do NOT collapse expand+swap into one deploy/promote. The partial covering index is built out-of-band `CONCURRENTLY` first on prod/staging (migration ships `IF NOT EXISTS` non-concurrent → no-ops there; a boot-migrator non-concurrent build would lock the large ledger).
- **CPU-spike scope note — org-spend fixed, features group-bys deferred.** The other CPU consumer is the per-workflow / timeseries stats group-bys (`/v1/stats/costs`, `/budget`, features-service reads, ~20% of DB time). They **cannot** use this de-join: they `LEFT JOIN` and 98% of runs in the big features have ZERO cost rows, so a single-table `FROM runs_costs` scan would drop those runs' `run_count` and every zero-cost group (validated). A covering index on the join is also ineffective (the full `runs_costs` scan for the LEFT JOIN survives). The correct fix is a split-aggregate rewrite (run_count/dimensions from `runs` index-only + de-joined cost sums merged) — deferred to its own focused, benchmarked PR.

## Cost predicate doctrine

Every cost aggregation in this codebase uses atomic status literals only. The
following compound predicates are the ONLY allowed ones, codified as PG
generated columns:

- `is_platform_projected` = `cost_source = 'platform' AND status IN ('actual','provisioned')`
- `is_platform_committed` = `cost_source = 'platform' AND status = 'actual'`

Atomic-literal predicates allowed inline:

- `status = 'actual'`
- `status = 'provisioned'`
- `status = 'cancelled'`
- `status IN ('actual','provisioned')` (== "displayed total")
- `cost_source = 'platform'`
- `cost_source = 'org'`

**Banned inline**: `status != 'cancelled'` or `status <> 'cancelled'`. The
negation form silently includes any future enum value. Use the explicit
`status IN ('actual','provisioned')` instead so a 4th status (e.g. `pending`,
`refunded`) defaults to NOT counted until consciously added — fail-safe.

**Shared SQL builder**: `src/services/cost-aggregator.ts` exports the canonical
SUM CASE WHEN blocks for total / actual / provisioned / cancelled / own / own-platform.
Every aggregation endpoint imports + uses these. New aggregation sites MUST
go through the aggregator — do not copy-paste inline CASE expressions.

**JS-side aggregation**: when summing in JS (children-summary), use explicit
status enumeration (`if status === 'actual' ... else if status === 'provisioned' ...`).
Never use `else` as a catch-all — that's the same mistake as `status != 'cancelled'`
in SQL.

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

### Current state — Phases 1-5 LIVE

| Layer | Tables / Views | Status |
|-------|---------------|--------|
| **Bronze** | `run_lifecycle_events`, `cost_lifecycle_events` (migration 0018); `run_events` (raw telemetry log) | Live source of truth, append-only. The lifecycle tables project to silver via triggers. `run_events` is a **leaf** bronze log — trace/telemetry events written directly by `POST /v1/runs/:id/events` (`src/routes/events.ts`), it projects to nothing and is read directly. Served for reads by access-pattern indexes (see below), never by a rollup/aggregate. |
| **Silver** | `runs`, `runs_costs` | Projection cache. Maintained by `project_run_lifecycle_to_silver` and `project_cost_lifecycle_to_silver` triggers (migration 0020). **App code MUST NOT INSERT/UPDATE these tables directly** (except `tests/helpers/test-db.ts` for test setup, and `POST /internal/transfer-brand` which is tracked as a follow-up). |
| **Gold** | **Inline bounded recursive CTEs** via the shared SUM-CASE builder in `src/services/cost-aggregator.ts` (NOT views). | Descendant cost rollup read by `POST /v1/runs/costs/batch`, `POST /v1/runs/batch`, `GET /v1/runs/:id`; org spend by `GET /internal/org-usage-total`. See "Gold = bounded CTE, never a view" below. |
| **Semantic predicates** | `runs_costs.is_platform_projected`, `runs_costs.is_platform_committed` (migration 0017) | Generated boolean columns + partial indexes. The single source for the platform-spend predicate, used by every gold rollup + `GET /internal/runs-expected-totals`. |

### Doctrine

- **Bronze is source of truth, append-only.** No FK to silver (bronze must survive cascade-deletes). Cross-reference via `run_id` / `cost_id` columns.
- **`run_events` is a leaf bronze telemetry log — serve its reads with access-pattern indexes, NOT a Gold rollup.** The live hot reader (`GET /v1/events?campaignId=X ORDER BY created_at DESC`, the dashboard launch-progress poll via api-service) wants the raw event ROWS, not an aggregate, so a Gold rollup table cannot serve it. The B/S/G-correct serving layer for a raw-row feed is a btree on its access key — `idx_run_events_campaign_created (campaign_id, created_at DESC)` (migration 0027). Without it the filter seq-scans the multi-million-row log (up to 47s observed), holding a pool connection and starving the cheap trace-event INSERTs → lead-service's `AbortSignal.timeout(5000)` fired and dropped trace events. Index built CONCURRENTLY out-of-band on prod/staging (a boot-migrator non-concurrent build would lock writes); the migration is `IF NOT EXISTS` so it no-ops there. Add a new `(<filter>, created_at)` index only when a NEW filter dimension proves a hot reader — do not pre-index every column, and do not reach for a rollup.
- **Domain events, not property sourcing.** Event types: `run.created | run.completed | run.failed | cost.added | cost.materialized | cost.cancelled`. Not `field_updated(field='status')`.
- **Events store delta + reason in `payload`, never the full aggregate** (avoid the "fat event" anti-pattern). `run.created` and `cost.added` carry the canonical row spec so the projection trigger can populate silver.
- **Idempotent HTTP replays (200 path) do NOT write bronze** — bronze captures state changes, not HTTP traffic. Dedupe happens BEFORE the bronze write via the existing idempotency-key pre-check.
- **All cost math stays in Postgres.** Generated columns encode the semantic predicates once. **Never** copy `cost_source='platform' AND status IN ('actual','provisioned')` as an inline literal — use the `is_platform_projected` generated column. Same for `cost_source='platform' AND status='actual'` → `is_platform_committed`.
- **Gold = bounded recursive CTE on read, never a view.** A plain VIEW is structurally wrong for a parametrised subtree rollup: an unbounded anchor (`SELECT id FROM runs`) forces PG to materialise the FULL recursive closure before any `WHERE root_run_id = $1` filter (PG can't push a predicate through a recursive CTE + GROUP BY). The 0019 gold views did exactly this and OOMed prod Neon to 20+ GB / 5+ CU on single-run lookups; they were unread after the `df9230e` revert and dropped in migration 0026. Read paths use inline recursive CTEs anchored on `WHERE id = $1` / `id IN (runIds)`, so PG only walks descendants of the requested roots (indexed by `idx_runs_parent`). The SUM-CASE aggregation is shared via `src/services/cost-aggregator.ts` — new rollup sites import it, never re-define a view. If O(1) reads are ever needed at scale, the correct gold is a materialised closure/rollup TABLE maintained on write, not a view.
- **`UpdateCostRequestSchema` only accepts `actual | cancelled`.** Re-provisioning an actual row has no domain meaning. Phase 5 narrowed the PATCH cost contract.
- **`POST /internal/transfer-brand` still mutates silver directly** (no domain event yet). Tracked as a follow-up.

### Backfill

Run once after deploy:

```bash
RUNS_SERVICE_DATABASE_URL=postgres://... npx tsx scripts/backfill-bronze-events.ts
```

Idempotent. DISABLES projection triggers during execution so synthetic events don't re-mutate the (already-canonical) silver rows. Pre-Phase-2 rows are marked `payload->>'backfilled' = 'true'`.

### Phase roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Generated cols + bronze tables + gold views | ✅ Merged (#129) — gold views later dropped (0026), see below |
| 2 | Bronze writes from handlers | ✅ Merged (#130) |
| 3 | Backfill script | ✅ Merged (#130) (manual invocation post-deploy) |
| 4 | Read swap to gold views | ⚠️ Merged (#130), then REVERTED (`df9230e`) — views OOMed prod; reads use inline bounded CTEs |
| 5 | Trigger projects silver from bronze | ✅ Merged (#130) |
| 6 | Rename silver to `_old` + auto-updatable view shim | ✅ This PR |
| 7 | Drop `_old` tables + view shim | ⏳ Deferred (user-driven, days/weeks later) |
| — | Drop dead gold views (`v_run_cost_rollup`, `v_org_platform_spend`, `v_runs_with_descendants`) | ✅ Migration 0026 — unread since `df9230e`; gold is now bounded-CTE-on-read |

### Phase 6 specifics — view shim, not naked rename

`runs` and `runs_costs` are now **auto-updatable PG views** passing through to the renamed base tables `runs_old` / `runs_costs_old`. Reasons this beat the naked-rename:

- **Zero code change.** Drizzle schema target stays `runs` / `runs_costs`. ~17 raw-SQL references in routes + ~9 in tests keep working.
- **Trigger function bodies stay intact.** `INSERT INTO runs` from `project_run_lifecycle_to_silver` forwards through the view to `runs_old` because auto-updatable views support write-through including `ON CONFLICT (id) DO NOTHING`.
- **Gold views auto-followed via OID** at the time of Phase 6 (no view recreation needed). Those gold views have since been dropped (migration 0026); the view shim over `runs_old` / `runs_costs_old` is unaffected.
- **Visible sunset signal in psql / Drizzle Studio.** `\d+ runs` shows VIEW (deprecated wrapper). `\d+ runs_old` shows BASE TABLE (live). Anyone connecting directly knows where the action is.

Auto-updatability requires: single-table reference, no aggregates / joins / DISTINCT / GROUP BY / LIMIT. `SELECT * FROM runs_old` qualifies.

#### Renaming / adding a silver column while the view shim is live

A column change on the live silver tables ripples through the shim — get the order right:

- **Rename a column:** a base-table `ALTER TABLE runs_old RENAME COLUMN x TO y` does **NOT** propagate to the `runs` view's output column — a `SELECT *` view freezes its output column names at creation time (verified on PG 17). You MUST rename it on BOTH the base table and the view: `ALTER TABLE runs_old RENAME COLUMN x TO y;` then `ALTER TABLE runs RENAME COLUMN x TO y;`. `ALTER TABLE <view> RENAME COLUMN` works on views, is metadata-only, and does **NOT** drop the view. Do NOT `DROP`/`CREATE OR REPLACE` the shim to rename a column: `CREATE OR REPLACE VIEW` can only append columns (not rename/reorder), and a naked `DROP` would CASCADE into whatever reads the shim. (As of migration 0026 the gold views `v_runs_with_descendants` / `v_run_cost_rollup` / `v_org_platform_spend` no longer exist, so they are no longer a DROP-blocker — but the rename-on-both rule still holds because the shim is still a `SELECT *` view.) Also update any projection-trigger function bodies that reference the column + payload key (add a `COALESCE(NEW.payload->>'newKey', NEW.payload->>'oldKey')` fallback for replay of pre-rename bronze events). Reference: migration 0025 (`customer_profile_id` → `audience_id`).
- **Add a column:** add it to the base table, then `CREATE OR REPLACE VIEW runs AS SELECT * FROM runs_old` (append is allowed) — see migration 0024.
- The gold views that used to read from the `runs` / `runs_costs` **views** were dropped in migration 0026; the shim now has no gold-layer dependents. Still `CASCADE`-audit before dropping the shim — the projection triggers and raw-SQL routes write through it.

## CI status checks ↔ branch protection

Branch protection on `staging` requires status checks named exactly `test-integration` and `test-unit`. The `test-integration` matrix job produces context names like `test-integration (stats, …)` which do NOT match the required name. A separate aggregator job named `test-integration` (depends on `test-integration-shard`, fails if any shard failed) provides the required context. When changing the matrix structure, keep the aggregator job name intact or PRs will sit in `BLOCKED` despite green shards.
