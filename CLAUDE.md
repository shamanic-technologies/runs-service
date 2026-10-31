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
- `src/routes/runs.ts` — CRUD routes for runs and costs (run-tree reads on `readDb`, see "Run creation never queues behind run-tree reads"; a campaign's running runs: "A campaign's running runs")
- `src/routes/refunds.ts` — staff cost-refund action (preview + apply). See "Refunded costs".
- `src/routes/incurred-costs.ts` — late declaration of never-charged past spend (preview + apply). See "Incurred, never-charged costs".
- `src/routes/no-campaign-spend.ts` — `GET /internal/org-no-campaign-total` (billing hot path) + `GET /internal/stats/costs/no-campaign/monthly` (staff). See "Campaign spend vs no-campaign spend".
- `src/routes/internal.ts` — `/internal/*` service routes, incl. `GET /internal/org-actual-total` (O(1), see "Org actualized total").
- `src/routes/health.ts` — Health check endpoint
- `src/services/brand-transfer.ts` — `POST /internal/transfer-brand` + `GET /internal/brand-transfers/moved-usage`. See "Brand transfer".
- `src/routes/task-units.ts` + `src/services/stats-rollup-task-units.ts` — `GET /internal/stats/costs/task-units` (fleet charged runs/orgs/units per task × asking service, migration 0049). See "Task units".
- `src/routes/run-outcomes.ts` — `GET /v1/stats/run-outcomes` (completed/failed/running, success rate, median duration). See "Run outcomes".
- `src/services/task-outcomes.ts` — `GET /internal/stats/task-outcomes` (fleet-wide per-task outcome, duration, whole-subtree cost of ONE service; route in `run-outcomes.ts`). See "Task outcomes".
- `src/routes/vendor-costs.ts` + `src/services/vendor-costs.ts` — `GET /internal/stats/costs/timeseries/vendor` + `GET /internal/stats/costs/vendor` + `GET /internal/stats/costs/margin` (+ `/timeseries`) + `GET /internal/runs/vendor` + `GET /internal/runs/subtree-costs` (all service-auth). See "Vendor-cost basis".
- `src/services/stats-rollup-campaign.ts` — (campaign, UTC day) rollup read + rebuild (migration 0037). See "Campaign-family cost reads".
- `src/services/stats-rollup-brand.ts` — brand-history reads (org-scoped `GET /v1/stats/costs`, public timeseries) from the same rollup (migration 0041), + audience (0052) and cost-name (0053) twins. See "Brand-history cost reads".
- `src/services/stats-rollup-org-task.ts` — org usage read (`GET /v1/stats/costs` by service/task/campaign) from the 0043 rollup. See "Org usage read".
- `src/services/stats-rollup-cost-day.ts` + `src/services/run-campaign-entries.ts` — margin rollup rebuild + entry-run projection backfill (migration 0040). See "Dashboard v2 reads".
- `src/routes/outcome-occurrences.ts` + `src/services/outcome-ledger.ts` (+ `src/services/ledger-reconciliation.ts`, "Ledger reconciliation") — outcome occurrences declared on runs, cost per occurrence, the to-the-cent ledger check and the coverage series (migration 0057). See "Outcome occurrences — the production-cost ledger". Totals read: `src/services/outcome-cost-totals.ts` (0058), see "Outcome ledger as totals". Take-back by the owning service (0059): "Taking a declaration back".
- `src/services/support-marks.ts` — support marks (which support function a run serves), doors + selection. See "Support spend, named and reported apart".
- `src/services/lead-states.ts` — allocation v5 inputs (catalogue lead states, pipe targets, lead-service first reaches -> `lead_state_reaches`). See "Lead states — allocation v5".
- `src/middleware/auth.ts` — API key authentication middleware
- `src/services/cost-resolver.ts` — Resolves unit costs from costs-service
- `src/services/billing.ts` — billing-service client. `notifyUsage` only — fire-and-forget cache-invalidation hint after each `runs_costs` write. Failures log to Railway; lifecycle never blocks. Truth lives in `GET /internal/org-usage-total` (billing-service re-reads on every authorize).
- `src/services/run-subtree-cost.ts` + `src/services/stats-rollup-subtree-cost.ts` — `include=subtreeCost` from `run_subtree_costs` (migration 0086). See "Subtree cost per run".
- `src/services/run-events-retention.ts` — 30-day retention sweep for the `run_events` leaf telemetry log. Started after `app.listen()`, every 6h. Never touches the bronze lifecycle logs.
- `src/db/schema.ts` — Drizzle ORM schema (organizations, users, runs, runs_costs)
- `src/db/index.ts` — Database connection
- `src/index.ts` — Express app setup and server entry point
- `tests/unit/` — Unit tests
- `tests/integration/` — Integration tests (supertest)
- `openapi.json` — Auto-generated, do NOT edit manually

## Parent-child conflicts: a sourcing serve has its own slug AND campaign (`src/services/feature-slug.ts`)

A child run whose identity fields disagree with its parent is a 409 (`Parent-child field conflict`), with two exceptions, both for a SOURCING child (slug `sourcing-*`) under a non-sourcing (outreach) parent, a parent with NO feature slug included (workflow-service opens many `execute-workflow` runs unlabelled; requiring a parent slug 409'd every lead-serve under them, 2026-10-08): lead-service opens each `lead-serve` run under the outreach workflow run but labels it with the sourcing ORIGIN slug (`featureSlugConflicts`) and, since source campaigns (owner 2026-10-07: an offer's lead sources are campaign-service campaigns keyed offer + origin + leg `start_to_lead_found`), files it under the ON SOURCE campaign's id (`campaignIdConflicts`). Its descendants inherit (or must equal) the source campaign and slug; every other mismatch (two outreach campaigns, a non-sourcing child naming another campaign, brands, workflow, org, user, attribution) still 409s. Guards: `tests/unit/campaign-id-conflicts.test.ts`, `tests/integration/runs.test.ts` ("SOURCE CAMPAIGNS").

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
- **EXPAND → BACKFILL → SWAP (mandatory ordering — this is money).** The read swap to the denormalized column must ship in a SEPARATE deploy, AFTER the out-of-band backfill (`scripts/backfill-cost-org.ts`, chunked/idempotent, run manually post-deploy — a full-table UPDATE on the multi-million-row ledger would block boot). A read-swap deployed before backfill completes would read the whale's NULL-org rows as ~0 → **billing over-authorizes**. Do NOT collapse expand+swap into one deploy/promote. The partial covering index is built out-of-band `CONCURRENTLY` first on prod/staging (migration ships `IF NOT EXISTS` non-concurrent → no-ops there; a boot-migrator non-concurrent build would lock the large ledger). **Chicken-and-egg — the index is on a NEW column added by the SAME migration, so you can't pre-build the concurrent index before the column exists. Pre-run BOTH on prod/staging before deploying: `ALTER TABLE runs_costs ADD COLUMN IF NOT EXISTS organization_id uuid` (instant metadata) THEN `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_costs_org_projected …` (no write lock). Then the boot migration no-ops both DDLs and only applies the view + trigger.** Full prod promote sequence: (1) pre-add column + concurrent index on prod; (2) promote #199 (boot migrate no-ops the DDL, applies view/trigger); (3) run `scripts/backfill-cost-org.ts` on prod → `remaining fillable 0`; (4) promote the read-swap PR. **Promote trap — `release.sh promote` carries the WHOLE staging→main delta, so the expand and swap PRs cannot both sit on staging when you promote (one promote would bundle both to prod, defeating the ordering). Keep the swap PR UNMERGED from staging until the expand is prod-deployed AND prod-backfilled; only then merge swap→staging and promote again.** The backfill is a single forward pass over `idx_runs_costs_created_at` windows (NOT a batch-LIMIT loop — that re-scans the whole NULL set every batch); short per-window locks, resumable. Shipped v0.42.0 (expand) + v0.43.0 (swap); prod validated byte-equal (de-join == old join) at 198ms vs ~4000ms.
- **CPU-spike scope note — org-spend fixed, features group-bys deferred.** The other CPU consumer is the per-workflow / timeseries stats group-bys (`/v1/stats/costs`, `/budget`, features-service reads, ~20% of DB time). They **cannot** use this de-join: they `LEFT JOIN` and 98% of runs in the big features have ZERO cost rows, so a single-table `FROM runs_costs` scan would drop those runs' `run_count` and every zero-cost group (validated). A covering index on the join is also ineffective (the full `runs_costs` scan for the LEFT JOIN survives). The correct fix is the split-aggregate rewrite, now shipped for the PUBLIC group-bys (see migration 0030 below) — the org-scoped `/v1/stats/costs` + `/budget` twins still await their own benchmarked PR.

## Denormalized run start on cost rows — de-join the cross-org stats reads (migration 0030)

`GET /public/stats/runs` buckets platform spend by the RUN's start date, but the money lives on `runs_costs` while the date lives on `runs`. It therefore fired FOUR unbounded aggregations per request — a monthly `runs ⋈ runs_costs` rollup (**14.2s × 506 calls**), the same work again for the weekly series (**13.6s**), plus a full `runs` status scan and a full `runs_costs` sum — with no time bound and no org bound. ~3h55m of pure execution per billing period, growing with the ledger whether or not traffic does (runs-service#206). Same fix family as 0028/0029: the writer already holds the run, so persist its `started_at` instead of re-deriving it on every read.

- **One nullable column on `runs_costs`** (`run_started_at timestamptz`) + a **partial covering index** `idx_runs_costs_projected_started ON runs_costs (run_started_at) INCLUDE (total_cost_in_usd_cents) WHERE is_platform_projected`, plus `idx_runs_started_status ON runs (started_at, status)` for the de-joined run counts. Both halves become index-only scans. NULL for pre-feature / pre-backfill rows.
- **Frozen at write from the RUN's `started_at`.** Both cost routes write `runStartedAt: run.startedAt` into the `cost.added` payload; the `project_cost_lifecycle_to_silver` trigger materializes it. `tests/helpers/test-db.ts` mirrors the freeze for direct silver inserts (as it already does for `organization_id`) — a helper-inserted cost with a NULL `run_started_at` is a *pre-backfill* row, not a normal one.
- **ONE UTC-day pass serves both series.** The monthly bucket truncates a timestamptz under the session TimeZone (UTC on this database) and the weekly one truncates an explicit `AT TIME ZONE 'UTC'`, so both are unions of UTC days and a single day grain rolls up to each losslessly. Each run has exactly one `started_at`, so distinct-run counts stay additive. `byStatus` and the untimed `totalCostInUsdCents` are then summed from those same buckets rather than re-scanned, which makes the **reconciliation invariant structural** here (sum of dated buckets == untimed total) instead of merely true.
- **A NULL `run_started_at` on a platform-projected row is a 500, not a skipped row.** It means the backfill is incomplete; serving it would drop that spend from the dated series AND the total while the reconciliation still "held". Fail loud.
- **`GET /v1/stats/public/costs` splits into (counts | sums) for every runs-side dimension.** The old single query LEFT JOINed the cost ledger then asked for `COUNT(DISTINCT r.id)`, forcing a SORT of the joined rows — for `groupBy=brandId` the join plus the `unnest(brand_ids)` explosion made 878k wide rows and a **62 MB external merge to disk on every call** (366 calls × 11.4s) to return five rows. The count never needed the join (it counts runs, and every public filter is a predicate on `r`), so `counts` reads `runs` alone and `sums` INNER JOINs; both are hash aggregates, no sort, no spill. Cost columns stay TEXT end to end so `ORDER BY total_cost DESC` keeps the same collation-dependent ordering, and `IS NOT DISTINCT FROM` keeps a NULL dimension in its own group. **`groupBy=costName` is deliberately NOT split** — its dimension lives on `runs_costs`, so splitting would scan the join twice instead of once.
- **EXPAND → BACKFILL → SWAP, same ordering and same promote trap as 0029.** Backfill via `scripts/backfill-cost-run-started-at.ts` (windowed on `created_at`, idempotent, retries transient Neon resets). It uses a **correlated scalar subquery**, not `UPDATE … FROM runs` — the FROM-join form lets the planner seq-scan all 2.9M runs *once per window* (>30s/window measured on prod). Re-run it after the expand deploys, to catch rows written between the backfill and the deploy.
- **Verified byte-equal against production**, old vs new in one `REPEATABLE READ` snapshot: identical md5 digests for the monthly and weekly series, identical `byStatus` (2761944 / 138128 / 35107), identical `1012624.4922729618` total — at **1.72s instead of ~28s**.
- **Index-only depends on the visibility map.** Both new reads are index-only *because* `runs` / `runs_costs` are vacuumed; if autovacuum falls behind (it had not run on `runs` for a week when this shipped, which was suppressing the plan) heap fetches climb and the scans slow down. Check `pg_stat_user_tables.last_autovacuum` before blaming the query.
- **Residual, not fixed here:** the per-brand read still scans the filtered feature's runs (3.8s → ~1.9s). Taking it to O(result) needs a brand-grain rollup — its own PR.
- **2026-10-22, migration 0054: the read is a rollup now.** At 6M runs the "index-only" plan lost to a seq scan (53 s, index-only 66 s under load, 30 s timeouts). `stats_rollup_run_day` (UTC start day x status, every status) + `stats_rollup_platform_cost_day` (run's UTC start day, NULL day kept so the read still fails loud) feed the same month/week SQL once `run_day` is stamped (`scripts/rebuild-stats-rollup.ts run_day`); a day counts while run_count > 0 / n_rows > 0. Guard: `tests/integration/task-outcomes-rollups.test.ts`.

## Write-maintained rollup for the cross-org per-workflow read (migration 0034)

`GET /v1/stats/public/costs?featureSlugs=X&groupBy=workflowSlug` is the fleet
benchmark features-service builds its workflow ranking from, once per viewed
brand / campaign / leg cell. Live, it re-scanned the feature's whole history on
every call — 1.16M runs for `sales-cold-email-outreach`, a 60 MB spilling
distinct-hash, 1.4 s of JIT, 5-9 s per call with 3-8 in flight (2026-09-24,
shared Postgres at ~400% CPU) — to return ~160 groups that only change when a
row lands. So it is maintained at WRITE time.

- **Tables**: `stats_rollup_runs (feature_slug, workflow_slug, run_count)` and
  `stats_rollup_costs (feature_slug, workflow_slug, cost_source, n_/gross_/net_
  per status)`, `UNIQUE NULLS NOT DISTINCT` (a NULL workflow is its own group,
  as in `GROUP BY`). Maintained by triggers on `runs` (insert, feature/workflow
  update, BEFORE delete — which also removes the run's costs, because the
  cascaded cost deletes can no longer see the run) and `runs_costs` (insert,
  delete, update of run/payer/status/amounts). A write that touches neither
  table's rows (`run.completed`) fires nothing.
- **Served shape only**: filters ⊆ {featureSlug(s), workflowSlugs incl. a
  resolved dynasty, costSource}, groupBy ∈ {workflowSlug, workflowDynastySlug,
  featureSlug}. An org/brand/campaign/task filter or any other grouping keeps the
  live query — the rollup does not carry those dimensions, and serving them from
  it would silently answer for the whole fleet.
- **Byte-identical, text included.** The live money columns are
  `SUM(CASE … ELSE 0 END)::text`: scale 10 when a row of that status matched,
  `'0'` when none did — and the response is ORDERed by that text. Hence the
  matched-row COUNT per status beside each sum; the read renders `'0'` on a zero
  count, `round(sum, 10)::text` otherwise. `tests/integration/stats-rollup.test.ts`
  compares rollup vs live (JSON and raw text) through inserts, every status
  transition, deletes, a run moved to another workflow, and a rebuild racing
  live writes.
- **Readiness**: the read uses the rollup only while `stats_rollups` holds the
  `feature_workflow` stamp (checked per request, a one-row PK probe — no
  in-process cache, because a rebuild un-stamps it). A fresh database is stamped
  by the migration. An existing one is stamped by
  `scripts/rebuild-stats-rollup.ts` (re-runnable any time): writers QUEUE for
  well under a second while it clears the rollup and exports a snapshot under a
  SHARE ROW EXCLUSIVE lock, then the ~20 s aggregate runs lock-free on that
  snapshot and is ADDED on top of the deltas that landed meanwhile. Every row
  counts once — in the aggregate if committed before the lock, as a delta after.
  In prod it runs inside the container against the compiled
  `dist/services/stats-rollup.js`.
- **`TRUNCATE` fires no row triggers.** Anything that truncates `runs` /
  `runs_costs` (tests/global-setup.ts) truncates the two rollup tables too.
- **JIT is off for the whole pool** (`connection: { jit: "off" }` in
  `src/db/index.ts`): it compiled 72 functions (1.4 s) per call on the read
  above, and no query here runs long enough to repay it.
- **Org-scoped sibling** (`GET /v1/stats/costs`): when every groupBy key and
  every filter is run-side (`workflowSlug,campaignId`, `workflowSlug`,
  `brandId`…), it now runs the same (counts | sums) split as the public read —
  the joined `COUNT(DISTINCT r.id)` sorted 435k rows for one brand's history.
  Measured 9.9 s → 2.5 s, identical rows in one snapshot. A cost-row dimension or
  filter (`audienceId`, `goal`, `brandProfileId`, `workflowContext`,
  `attributionStatus`, `costName`) can put one run in several groups, so
  `audienceId,workflowSlug` keeps the joined query (JIT-off only). The run-side
  brand-scoped reads are now O(groups) from the campaign-day rollup (migration
  0041, "Brand-history cost reads"); the audience reads from their own rollup (0052), the cost-name ones from 0053.
## Org actualized total — maintained on write, read in O(1) (migration 0035)

billing-service reads an org's ACTUALIZED platform charges (net of the usage
discount) on every dashboard page. `GET /internal/runs-expected-totals` computes
it by scanning the ledger: 5.4s / 33 MB for the heaviest org, and even the totals
alone are >=400ms on prod because ~700k rows must be summed. A scan cannot meet a
dashboard budget, and the ledger only grows. So the total is KEPT.

- **`org_actual_totals`** — one row per org: gross + net, unconstrained `numeric`
  (a lifetime total overflows `numeric(16,10)`; every addend is scale 10, so the
  `::text` stays byte-identical to `SUM(...)::text`). App code never writes it.
- **Maintained by triggers, in the same transaction as the write** — so it is
  never stale, which is what separates it from a cache:
  `trg_org_actual_totals_cost` (runs_costs INSERT/UPDATE/DELETE),
  `trg_org_actual_totals_run_update` (runs status/org change),
  `trg_org_actual_totals_run_delete` (BEFORE DELETE, while the FK-cascaded costs
  still exist). Included row = `is_platform_committed` AND run status IN
  ('completed','failed') AND run org NOT NULL, keyed on the RUN's org — exactly
  runs-expected-totals' definition.
- **Concurrency: every trigger locks the org's row FIRST, then reads run status /
  sums costs.** Each plpgsql statement takes a fresh snapshot, so whichever
  transaction takes the lock second sees the other's committed write. A trigger
  that reads before locking loses money under concurrency: the first version
  skipped the lock on a running→completed transition with an unchanged org, and
  a 20-run concurrent test lost ~5% of the total. The concurrent test in
  `tests/integration/org-actual-total.test.ts` is what catches it — keep it.
- **Read:** `GET /internal/org-actual-total?org_id=` → `{org_id,
  total_expected_cents, net_total_expected_cents, as_of}`, one PK lookup. '0'
  when no row or gross is 0 (exactly when runs-expected-totals' per-run set is
  empty, since costs are never negative).
- **TRUNCATE fires no row triggers** — anything that truncates runs/runs_costs
  (tests/global-setup.ts) must truncate `org_actual_totals` too.
- `POST /internal/transfer-brand` now also moves `runs_costs.organization_id`
  with the run, so `org-usage-total` (0029's denormalized org) follows the move.

## Campaign spend vs no-campaign spend (migration 0045)

Owner 2026-10-13: a customer is charged only what its campaigns spend ("à la Google
Ads"); spend outside a campaign (Copilot chat, onboarding reads, A/B work, card
fees) stays declared and recorded here, and the platform absorbs it, forward-only
from a cutover instant billing-service owns.

- **THE RULE: a cost row is campaign spend iff its RUN carries a `campaign_id`.** A
  run's campaign is set once at creation and no projection changes it; a child run
  created without one inherits its parent's (`POST /v1/runs`), so every service call
  inside a campaign workflow is campaign spend, a sourcing serve filed under its
  source campaign included. A platform run (no parent) is campaign spend only when
  its writer states the campaign. Prod check: matches the brief's hand-measured
  monthly no-campaign figures to the cent (Feb..Sep 2026).
- **Frozen on the cost row at insert**: `runs_costs.run_has_campaign` set by the
  BEFORE INSERT trigger `trg_freeze_cost_run_has_campaign` (one runs_pkey probe), so
  test-helper silver inserts get it too. NULL = not known (pre-feature, before
  `scripts/backfill-cost-run-has-campaign.ts`); never folded into either side.
- **`GET /internal/org-no-campaign-total?org_id&since`** (billing, every authorize):
  the no-campaign part of BOTH totals for rows `created_at >= since`, same field
  names as the totals it splits (`spent_cents`/`net_spent_cents` ⊂ org-usage-total,
  `total_expected_cents`/`net_total_expected_cents` ⊂ org-actual-total), so total −
  part = campaign part field for field. Whole UTC days after the cutover come from
  **`org_no_campaign_days`** (migration 0046: per org × UTC day of the cost row,
  projected keyed on the cost row's org, actual on the run's org; triggers on
  runs_costs + runs, actual part locks `org_actual_totals_lock(org)` first, the 0035
  rule), the cutover's own partial day live (`idx_runs_costs_org_no_campaign`;
  nothing when `since` is a UTC midnight). Live-only was 3.8 s cold for the owner
  org over 13 days. A NULL row in the window = 500 (`idx_runs_costs_org_campaign_unknown`).
  Parity guard (rollup vs live, red if a trigger is disabled):
  `tests/integration/org-no-campaign-days.test.ts`. TRUNCATE fires no triggers:
  global-setup truncates the table too.
- **`GET /internal/stats/costs/no-campaign/monthly`** (staff, statsDb): per org per
  UTC month of `created_at`, projected platform spend split no-campaign / campaign /
  unknown, gross + net, plus `noCampaignByCostName` (billing sets acquiring fees
  apart); `months[]` dense fleet totals since the first row. Served from
  **`stats_rollup_no_campaign_day`** (migration 0055: per cost row's org × UTC day ×
  cost name × `run_has_campaign`, n + gross + net, atomic upsert trigger) once stamped
  `no_campaign_day` (`scripts/rebuild-stats-rollup.ts no_campaign_day` after the deploy);
  live it scanned all 1.32M projected rows + a 109 MB disk sort, 95 s at box load ~89,
  every call 500 on the 30 s timeout (2026-10-23). Parity guard (rollup vs live, raw
  bodies, red if the trigger is off): `tests/integration/no-campaign-spend.test.ts`.
  **`orgBasis=incurred`** (migration 0056) keys orgs[] on the org the run was OPENED
  under (bronze run.created `organizationId`, `run_origin_org()`), so a transferred
  brand's history stays on the org that spent it (Doc Dinners' pre-2026-09-28 spend on
  agency b645207b); default `current` = the cost row's org now. months[] is the same on
  both. Rollup rows carry `origin_org_id`; rows from before 0056 have none, so a row's
  n can go negative: every read test is on a GROUP's SUM(n). Incurred basis needs the
  extra stamp `no_campaign_origin` (set by the same `no_campaign_day` rebuild).
- **`hasCampaign=true|false` on `GET /v1/stats/public/costs/timeseries`** (live and
  rollup paths: `campaign_id IS [NOT] NULL` on the run): billing's 14-day forecast
  reads campaign spend only.
- Index built CONCURRENTLY out-of-band on prod (migration `IF NOT EXISTS` no-ops).

## Runs of a campaign FAMILY in one request (migration 0036)

A campaign as the customer knows it is often many stored campaign rows
(campaign-service keeps every superseded row; one real campaign has 47).
`GET /v1/runs?campaignIds=a,b,c` answers for the whole set in one call instead of
one call per id (features-service `observedPicks` fanned out 47 calls).

- **Page first, then sum costs.** With a `limit`, the handler picks the page's run
  ids first and only then LEFT JOINs `runs_costs` for those ids. The old single
  query grouped every matching run before the LIMIT, so a 50-row read of a busy
  campaign summed costs for all 27k of its runs. Applies to every `GET /v1/runs`
  caller, not only `campaignIds`; response shape unchanged, order is now
  `startedAt DESC, id DESC` (the tie-break is new, ties were arbitrary before).
- **`campaignIds` + `limit` = per-member LATERAL top-(limit+offset) on
  `idx_runs_campaign_started (campaign_id, started_at DESC)`, then the global
  top.** Exact by construction: a run carries one campaign, so a run outside its
  member's top (limit+offset) cannot be in the global one. The two obvious plans
  are both bad on prod: `campaign_id = ANY(...) ORDER BY started_at DESC LIMIT`
  either top-N-sorts the family's 58k runs (1.7s) or walks
  `idx_runs_started_status` backwards (4.1s for a family whose runs are old).
- **That page query runs with `SET LOCAL enable_bitmapscan = off`** (own
  transaction). Once `limit` nears the planner's per-member estimate (~500) it
  otherwise swaps the ordered walk for a BitmapAnd with `idx_runs_org_service`
  (220k rows for a big org) plus a sort per member: 2s instead of 0.3s at
  limit=201 in prod (v0.47.5 → v0.47.6). Do not remove it without re-measuring
  limit 1 / 51 / 201 / 1000 on the 47-row family.
- Without `limit` the list is a plain `campaign_id IN (...)`. Blank/duplicate ids
  are dropped; empty list or more than 500 ids is a 400. ANDs with `campaignId`.
- The index was built `CONCURRENTLY` out-of-band on prod (21.5s); the migration's
  `IF NOT EXISTS` no-ops there.

## Campaign-family cost reads — (campaign, UTC day) rollup (migration 0037)

A campaign as the customer knows it is a FAMILY of stored campaign rows (one per
workflow switch; the busiest has 47). features-service refreshes a campaign
Overview every few seconds and used to ask the dated spend once per row (47
timeseries reads per refresh, features-service#1045). Asked live for the whole
family, it is 322k runs joined to their costs: 3.3 s. So it is maintained at write
time, same pattern and same byte-identity rules as 0034.

- **`campaignIds`** (comma-separated, ≤500, blanks/dupes dropped, empty or >500 =
  400; shared parser `src/services/campaign-ids.ts`, also used by `GET /v1/runs`)
  on `GET /v1/stats/public/costs/timeseries`, `GET /v1/stats/public/costs` and
  `GET /v1/stats/costs`. ANDs with `campaignId`.
- **Timeseries `groupBy=campaignId`** — one bucket per (period, campaign), each
  carrying `campaignId`, ordered by period then campaign. Absent = unchanged shape.
  Per-row totals = `GET /v1/stats/public/costs?groupBy=campaignId&campaignIds=…`.
- **Tables** `stats_rollup_campaign_runs` / `stats_rollup_campaign_costs`, key
  `(campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug[,
  cost_source])`, `day` = `started_at` as a UTC date. Since 0041 EVERY run is rolled
  up (a NULL campaign is its own group) with min/max started_at per run group. Triggers on `runs` (insert, update of any key column incl.
  `started_at`/`brand_ids`, BEFORE delete) and `runs_costs`.
- **Served shape (public costs)**: a campaign filter (`campaignId` and/or
  `campaignIds`) and otherwise only orgId / brandId / featureSlug(s) /
  workflowDynastySlug / costSource; groupBy ∈ {campaignId, workflowSlug,
  workflowDynastySlug, featureSlug}. **`groupBy=brandId` is served with or without a
  campaign filter** (counts under each DISTINCT brand of the row's array, money under
  each element, as the live `unnest`): the homepage ranked-by-brand read was 48 s live
  over the cold-email feature (2026-10-19, statement timeouts), 0.13 s from here,
  byte-equal in one snapshot. A taskName keeps the live query. Every path states each
  group's `minStartedAt` / `maxStartedAt` (first / last run start, = the org-scoped
  read's; were null until 2026-10-22, the staff Research "Last run" column): from this
  rollup's clean rows, a `minmax_stale` row re-read live by its key + day (fenced
  LATERAL); the 0034 feature_workflow path takes them from this table too (live MIN/MAX
  while `campaign_day` is un-stamped). The
  timeseries and org-scoped `GET /v1/stats/costs` reads: see "Brand-history cost reads".
- **Readiness** stamp `campaign_day` in `stats_rollups`; on an existing database run
  `scripts/rebuild-stats-rollup.ts campaign_day` after the deploy (in prod: inside
  the container against the compiled `dist/`). `rebuildRollup` in
  `src/services/stats-rollup.ts` is the shared lock/snapshot protocol for both
  rollups.
- **TRUNCATE fires no row triggers** — `tests/global-setup.ts` truncates these two
  tables with the ledger.

## Brand-history cost reads — the campaign-day rollup, every run (migration 0041)

features-service reads a brand's whole cost history (`GET /v1/stats/costs`, org +
brand + 5 feature slugs, groupBy workflowSlug / campaignId / both, often split at a
UTC midnight into a past half `startedBefore=…T23:59:59.999Z` and a today half
`startedAfter=…T00:00:00Z`) several times a minute. Live, 1-3 s each over 500k+
runs; ~60% of runs-service's active DB time (2026-10-08). Served from the 0037
tables, extended rather than duplicated (same grain).

- **Extension**: `campaign_id` nullable (runs without a campaign rolled up; every
  0037 read filters on a campaign so never sees them); `min_started_at`,
  `max_started_at`, `minmax_stale` on the runs table. A removal (delete, key move)
  cannot shrink min/max without a scan, so it sets `minmax_stale`; a rebuild clears it,
  and so does the in-process REPAIR pass (`src/services/stats-rollup-minmax-repair.ts`,
  ~60 s after listen then every 5 min, kill switch `STATS_ROLLUP_MINMAX_REPAIR_ENABLED=false`):
  per stale row of the 0041/0042/0043 tables, lock it, recount its runs, write exact
  min/max only when the count equals `run_count` (else leave it stale and report).
  Without it stale rows only accumulated (849 rows / 167 days on 2026-10-14) and a
  brand-history read of brand f4d73dab read 25 days live = an org-wide scan past the
  30 s statement timeout. Guard `tests/integration/stats-rollup-minmax-repair.test.ts`.
- **Served** (`src/services/stats-rollup-brand.ts`, statsDb): org-scoped
  `GET /v1/stats/costs` with groupBy ⊆ {workflowSlug, workflowDynastySlug,
  campaignId, featureSlug} and filters ⊆ {brandId, campaignId(s), featureSlug(s),
  workflowSlug(s)/dynasty, startedAfter, startedBefore}; and
  `GET /v1/stats/public/costs/timeseries` with tz UTC and no taskName (any other
  filter, bounds included, campaign or not). Anything else stays live.
- **Exact bounds**: a bound cuts through one UTC day; that day comes from the
  rollup when the excluded part of it holds no run matching the filters (always,
  for midnight bounds), else it is read LIVE with the exact bound. Days holding a
  stale group (min/max reads only) are read live too. Rollup days and live days
  are disjoint, one statement, one snapshot. The live-day LATERAL keeps `OFFSET 0`
  (fence): without it the planner joined the brand's whole bounded history to
  runs_costs before seeing live_days empty (11-21 s, f4d73dab, 2026-10-21; fenced
  0.05-0.2 s). Guard `tests/unit/stats-rollup-brand-fence.test.ts`.
- **Readiness**: same `campaign_day` stamp. The 0041 migration un-stamps an existing
  database (NULL-campaign history and min/max missing) → run
  `rebuild-stats-rollup.ts campaign_day` right after the deploy. Un-stamping is also
  the instant kill switch (every gated read goes live).
- **Parity guard**: `tests/integration/stats-rollup-brand.test.ts` (rollup vs live,
  raw bodies, through inserts, transitions, deletes, key moves, racing rebuilds;
  red if the boundary-day or stale-day logic is disabled).
- **Audience groupings**: their own twin tables, see "Per-audience cost reads" (0052).

## Per-audience cost reads — (campaign, UTC day, …, audience) rollup (migration 0052)

features-service's per-audience x workflow spend (`GET /v1/stats/costs?groupBy=audienceId,workflowSlug`,
org + brand + campaign family + 7 feature slugs, often `startedBefore`) LEFT JOINed the brand's whole
history to the ledger and sorted every joined row for `COUNT(DISTINCT r.id)`: 21-29 s for brand
f4d73dab (314k runs, 40 MB external sort), ~345 statement-timeout 500s in 30 h (2026-10-19).

- **Tables** `stats_rollup_audience_runs` / `_costs`: the 0041 key + `audience_id` = the EFFECTIVE
  audience `COALESCE(rc.audience_id, r.audience_id)`. A run sits in one group per distinct effective
  audience of its cost rows (its own audience when it has none) — a separate table because adding
  the audience to the campaign-day grain would double-count such runs in every other read.
- **Membership triggers**: a cost write recomputes the run's audience set before (rows now − NEW + OLD)
  and after, and applies the difference. A per-run `pg_advisory_xact_lock(52052, hashtext(run_id))` is
  taken FIRST and the set read in a later statement (0035's lock-then-read): without it, two first cost
  rows of one run each removed the run from its own audience (the concurrency test is red without it).
  A multi-row statement writing several cost rows of ONE run with different audiences is not exact
  (same accepted edge as 0049); no writer does that. Prod: every cost row's audience equals its run's
  (2.17M / 2.17M, 2026-10-19), so membership never actually moves.
- **Served** (`readBrandRollupGroups(rollup: "audience")`): audienceId in groupBy, the other keys ⊆
  {workflowSlug, campaignId, featureSlug} (+ dynasty regroup), filters ⊆ 0041's (brand, campaign(s),
  feature(s), workflow(s), bounds) — no goal/brandProfile/audience/workflowContext/attribution/service/
  task filter, no costName. Bounds and stale days follow 0041 (live days count DISTINCT runs over the
  LEFT JOIN). The min/max repair pass covers the table (membership-aware recount).
- **Readiness** stamp `audience_day`; run `scripts/rebuild-stats-rollup.ts audience_day` after the deploy.
  TRUNCATE in global-setup. Parity guard: `tests/integration/stats-rollup-audience.test.ts`.

## Brand spend by cost name — (campaign, UTC day, …, cost name) rollup (migration 0053)

features-service's brand revenue body (`spend-client.ts`) reads `GET /v1/stats/costs?groupBy=costName` (or
`costName,campaignId` for a family), org + brand + the offer's feature slugs, lifetime AND `startedAfter=<UTC midnight>`.
Live it INNER JOINed the brand's history to the ledger: Doc Dinners (brand 75d7e3e8, 412k runs) = seq scan of all
2.18M cost rows + 30 MB sort, 15.8 s quiet, past the 30 s statement timeout under load, every attempt 500 (2026-10-19).

- **One table** `stats_rollup_cost_name_day`: the 0041 key + `cost_name`, run count + min/max/stale AND money per
  status + `quantity` (Σ over every status = the live `totalQuantity`). A run counts once per distinct cost name of
  its rows, never without a row (INNER JOIN). Run count = 0049's rule (upsert the key row first, check OTHER rows of
  the run with that name in a later statement); a status/amount/quantity change never touches membership, so the
  provisioned -> actual write never marks a group stale.
- **Served** (`readBrandRollupGroups(rollup: "costName")`): costName in groupBy, other keys ⊆ {workflowSlug,
  campaignId, featureSlug} (+ dynasty), filters ⊆ 0041's (brand, campaign(s), feature(s), workflow(s), bounds); no
  goal/brandProfile/audience/workflowContext/attribution/service/task. Bounds and stale days follow 0041. The min/max
  repair pass covers the table.
- **Readiness** stamp `cost_name_day`; run `scripts/rebuild-stats-rollup.ts cost_name_day` after the deploy (prod:
  inside the container against `dist/`). TRUNCATE in global-setup. Parity guard (red if the "other row" check is
  dropped): `tests/integration/stats-rollup-cost-name.test.ts`.

## Consumption read — (org, brand set, UTC day, cost name, source) rollup (migration 0090, CONSUMPTION-500-1029)

costs-service's real-cost refresh reads `GET /internal/stats/costs/consumption?groupBy=orgId` and `orgId,brandId`
since inception, in parallel. Live: 1.82M counted cost rows, and by brand a hash join to the 7M-row runs table
(6 s / 28 s at load 15, 89 s at load 30): past the stats 30 s timeout, every refresh 500'd 2026-10-16 → 10-29 and
the billed catalogue froze.

- **`stats_rollup_consumption_day`**: counted rows (actual/refunded) keyed on the COST ROW's org + created_at UTC day,
  cost name, source, and the RUN's `brand_ids` kept as an array (unnested at read, so co-branded rows count under each
  brand). `n` = matched rows; a group at n = 0 serves nothing. Triggers: cost write (OLD out / NEW in, run resolved by
  pk; run gone = cascade, skipped), run `brand_ids` update (move its rows), run BEFORE DELETE (take its rows out).
- **Served** for every filter/groupBy of the route (`services/stats-rollup-consumption-day.ts`), stamp + rows in ONE
  statement; unstamped = the live query. Figures are Decimal-formatted by the route, so the body is identical.
- **Readiness** stamp `consumption_day`; run `scripts/rebuild-stats-rollup.ts consumption_day` after the deploy (prod:
  inside the container against `dist/`). TRUNCATE in global-setup. Guard: `tests/integration/stats-rollup-consumption.test.ts`.

## Org usage read — (org, service, task, campaign, UTC day) rollup (migration 0043)

features-service `GET /orgs/usage` (Billing, Today, copilot `get_org_usage`) asks
`GET /v1/stats/costs?groupBy=serviceName,taskName,campaignId` for the WHOLE org.
Live that groups every run of the org: 985k runs for the owner org f0420eb5, ~33 s,
past the 30 s stats `statement_timeout` (12 × 500/day, 2026-10-09). The 0037/0041
rollup has no service/task, hence its own table.

- **Served** (`src/services/stats-rollup-org-task.ts`, statsDb): org-scoped, groupBy
  ⊆ {serviceName, taskName, campaignId}, filters ⊆ {campaignId(s), serviceName,
  taskName}, NO bounds (a bound, brand, feature or workflow filter stays live). The
  brand rollup keeps priority where both could serve.
- **One table** `stats_rollup_org_task`: run count, min/max/`minmax_stale`, and per
  status n + gross + net. Triggers on runs (insert, update of org/service/task/
  campaign/started_at, BEFORE delete) and runs_costs. A UTC day holding a stale row
  is read live (0041's rule).
- **Readiness** stamp `org_task`; run `scripts/rebuild-stats-rollup.ts org_task`
  after the deploy (prod: inside the container against `dist/`).
- **Parity guard**: `tests/integration/stats-rollup-org-task.test.ts` (raw bodies,
  red if the stale-day logic is disabled).

## Run outcomes — how runs ended and how long they took (`GET /v1/stats/run-outcomes`)

The dashboard's per-crew cards ("97% success, 38 failed", "median run 1m 52s")
read this per campaign. Org-scoped, filters brandId / campaignId / campaignIds
(a FAMILY, shared parser) / workflowSlug / featureSlug / serviceName / taskName /
startedAfter / startedBefore; groupBy is run-side only (default `campaignId`), so a
run lands in exactly one group and the median is exact (no dynasty regroup:
medians do not merge).

- **Default `scope=entry` counts ENTRY runs only**: a run whose parent is not a
  run of the SAME campaign (or no parent). In prod a campaign's tree is
  `campaign-service/campaign-trigger` or `api-service` (no campaign) →
  `workflow/execute-workflow` (carries the campaign) → ~15 child service calls
  (same campaign). No root run carries a campaign, so "root only" would count
  nothing; counting every node would weigh one agent run as ~15 and report a
  service call's 2 s as its duration. `scope=all` counts every matching run and
  reconciles status-for-status with `GET /v1/runs` under the same filters.
- `medianDurationMs` = median of `completed_at − started_at` over COMPLETED runs;
  **null (never 0) when the group has no completed run**. `successRate` =
  completed / (completed + failed), null when none ended; running runs are not
  decided yet. Statuses are enumerated, never negated.
- Cost: the entry test is one PK lookup per candidate run. Busiest brand, 30 days:
  ~0.95 s warm (229k candidate runs); one day: ~0.23 s.

## Task outcomes — fleet-wide, per task of one service (`GET /internal/stats/task-outcomes`)

api-registry-service shows, per endpoint of every service, the mean cost, mean
duration and success rate of one run, so an agent can pick endpoints when it
builds a workflow. Service-auth, no org header: every org AND org-less platform runs.

- **Grouping key** = `task_name` with every UUID (case-insensitive) replaced by
  `{id}` (`GET /v1/offers/<uuid>/revenue` → `GET /v1/offers/{id}/revenue`).
  `totalRunCount` is all time; everything else is over the task's newest `sample`
  runs (default 200, 1..1000, `started_at DESC, id DESC`).
- **Cost** = each sampled run's WHOLE subtree, `status = 'actual'` rows only, every
  cost source, gross billed; a run with no cost counts 0. `sum*` fields are there
  so a consumer can merge groups exactly.
- **Rollup paths (migration 0054, 2026-10-22)**: live it took 37-225 s (seq scan of all `runs` for
  the window + walks of 2.38M runs for api-service, 596k for campaign-service; 290 s timeouts at
  load 30-50). Two rollups, each used only while stamped (checked in the read's transaction):
  - **Sample from `org_task` (0043)**: per normalized task, total = SUM(run_count); D = newest UTC
    day from which it holds >= `sample` runs; each (campaign, raw task) key with a day >= D is read
    newest-first off `idx_runs_campaign_task_started` with `LIMIT sample` (split NULL / non-NULL
    campaign). Same rows as the window (prod md5-equal, api-service 54,979, campaign-service 282).
  - **Top-level subtree cost from `stats_rollup_root_cost` (0054)**: a sampled run with NO parent
    reads its whole-subtree actual cost by PK; only the others are walked (fenced LATERAL children,
    fenced per-run cost LATERAL). Triggers: a cost row walks `parent_run_id` up to its top-level
    run (PK lookups); a run delete (BEFORE, still visible) subtracts its visible subtree, a broken
    chain (ancestor deleted earlier in the statement) skips: exact in any row order; a reparent
    moves the subtree. Rebuild `root_cost` is bottom-up per level, GROUPED (a top-down carry would
    hold ~76M rows for the dead 13,741-deep scheduler-resume chain of 2026-04-01).
  Guards: `tests/unit/task-outcomes-fence.test.ts`, `tests/integration/task-outcomes-rollups.test.ts`
  (every stamp combination == live).
- Live-path plan rules (kept for the fallback): the sample is `MATERIALIZED`; the child fetch is a
  LATERAL with `OFFSET 0`; cost is a plain hash join to `runs_costs` (2.25M probes = ~25 s).
  Raising `work_mem` to 128MB made api-service 111 s: do not.
- **Runs past the 30 s analytics `statement_timeout`**: the read sets
  `SET LOCAL statement_timeout = '290s'` in its own transaction, holds at most 2 of
  the 8 analytics connections (in-process queue), and coalesces identical requests.
  The consumer must cache and refresh in the background.
- `completed_at < started_at` exists in prod (7,436 completed runs, clock skew
  between writers): durations are reported raw, never clamped.

## Vendor-cost basis — dated spend priced at what the vendor charged us (`GET /internal/stats/costs/timeseries/vendor`)

The staff "Actual cost" view needs the dated spend of `GET /v1/stats/public/costs/timeseries`
on the VENDOR basis (before our markup). A cost row stores only the BILLED unit price, and
the markup moved (1x → 2x → 4x → 5x → 6x → 5x), so nothing here may divide by a constant.

- **costs-service states the vendor cost per price version** (`GET /internal/vendor-costs`,
  service-auth). runs fetches the whole catalogue in one call (5-min in-process cache) and
  prices at READ: no column, no backfill — a correction in costs-service reprices history.
- **Match** = same `cost_name` + same billed unit price as the row froze + the latest such
  version whose served-from (`max(effectiveFrom, createdAt)`, costs-service's "would have
  served" rule) is `<=` the row's `created_at`. Windows are per (name, billed price), so each
  row matches at most one version. Vendor total = `quantity × vendor unit`, in `numeric`.
  The FIRST window of each (name, billed price) opens at -infinity (PUBLIC-VENDOR-COST-1031):
  a late declaration (`/internal/incurred-costs`) is dated at `incurredAt` but priced when
  recorded, so it sits before every version carrying its price (102,354 comped Instantly sends
  of 2026-08-24..10-14, recorded 10-18 at 2.8403: $2,907 read unpriced, 11.8% of fleet spend);
  a live write never does, so no other row moved (prod check 2026-10-31). Stored ledger days
  follow on their next recompute, like any catalogue correction.
- **Unknown is stated, never folded in**: vendor `null`, or no version matching at write time
  → the row's BILLED amount goes to `unpriced*`, its name to `unpricedCostNames`. Catalogue
  unreadable → 502, never an all-unpriced 200.
- **Speed (migration 0047)**: run counts are read from `runs` alone (index-only), money from the
  cost rows of a summed status only (counts ⟕ money, as 0030). The FLEET read by run-start window
  only (no other run filter, no `groupBy`: the admin cash forecast's 14-day call) takes its money
  from `runs_costs` alone by `run_started_at` (`idx_runs_costs_run_started`): that column is the
  run's `started_at` truncated to the ms (0 exceptions on 2M prod rows, 2026-10-17), so buckets
  match and only rows within 1 s of a bound are decided by a PK probe of their run. Any NULL
  `run_started_at` → the joined path. Prod: 15-47 s (timeouts) → ~2.4 s, byte-equal; guard
  `vendor-cost-timeseries-ledger.test.ts` (red if the band check is dropped).
- **Per workflow version** (PUBLIC-VENDOR-COST-1031 follow-up): `workflowSlug` / `workflowSlugs` filters and
  `groupBy=workflowSlug` (one bucket per (period, version), carrying `workflowSlug`) — features-service rebuilds the
  public index history per version per run-start UTC day in ONE read per org x campaign set; per bucket billed
  `totalCostInUsdCents` + `runCount` == `GET /v1/stats/costs/timeseries?workflowSlug=` (guard in
  `vendor-cost-timeseries.test.ts`). With tz UTC and no taskName its MONEY comes from the 0050/0051 rollup
  (`vendorGroupedRollupBaseSql`, items carry `run_day`), run counts stay live (index-only): live, a 20k-run
  campaign read 25 s at load 33. Parity (raw bodies, rollup vs live): `stats-rollup-campaign-cost-items.test.ts`.
- **Never on a public route** — the vendor cost reveals the margin. The public timeseries is
  untouched; the route is `/internal/*` behind `requireInternalAuth`.
- **Per run: `GET /internal/runs/vendor?orgId=…`** — `GET /v1/runs`' exact list (shared
  `listRunsPage` in `routes/runs.ts`: same filters, order, page, billed `own*` fields byte-for-byte)
  plus each run's cost on the vendor basis, own (`vendorOwn*`, `unpricedOwn*`) AND subtree
  (`total*` billed == `GET /v1/runs/:id`'s total, `vendorTotal*`, `unpricedTotal*`, `unpricedCostNames`),
  same matching as the timeseries. Org from the `orgId` query (staff read any org), not `x-org-id`.
  ⚠️ An `execute-workflow` run has NO own cost rows (0 of 2,368 in prod, 2026-09-28): its cost is
  its subtree, so a Workflow page must read `total*` / `vendorTotal*`, never `own*`.
  Its subtree walk fetches each run's cost rows through a per-run LATERAL with `OFFSET 0` (the
  fence stops Postgres flattening it back into the plain JOIN that hash-joined a seq scan of the
  whole ledger, 1.2-2.1 s a 20-run page in prod before, 2026-09-28). Same rule as the customer twin below.
- **Customer twin of `total*`: `GET /v1/runs?include=subtreeCost`** adds each run's SUBTREE billed
  cost (`totalCostInUsdCents`, `actualCostInUsdCents`, `provisionedCostInUsdCents`, same names and
  values as `/internal/runs/vendor` and `GET /v1/runs/:id`; `src/services/run-subtree-cost.ts`),
  plus the same split on the frozen NET basis (`netTotal/netActual/netProvisionedCostInUsdCents`,
  COALESCE(net, gross) per row; features-service sums net over lead-serve runs for sourcing spend),
  never a vendor figure. OPT-IN and requires `limit` 1..500: hot callers (campaign-service
  gate-check lists completed campaign-trigger ROOTS with `limit: maxLeads`, whose subtrees are whole
  campaign trees) never read it and must not pay the walk. Prod: 50 execute-workflow runs, 455
  descendants: the walk is a per-run LATERAL on idx_runs_costs_run_agg (~15 ms join; a plain JOIN hash-joined a seq scan of the ledger, 1.2 s). An unknown `include` value is a 400.
- **Every run at once: `GET /internal/runs/subtree-costs?orgId=…&brandId|campaignId=…[&serviceName&taskName]`** — no page,
  one statement: each matching run's committed (`actual`) SUBTREE cost on billed, frozen net, vendor and unpriced, equal run for
  run to `/internal/runs/vendor` + `/v1/runs?include=subtreeCost` (guard `run-subtree-costs.test.ts`). Read by features-service
  (sourcing investment; Threads template ranking). brandId or campaignId required (400). Each run also serves `supportFunction`
  = kind of the nearest support mark among itself + ancestors (a mark covers its subtree; null = none): a consumer leaves
  those runs out of an outcome. Upward walk = PK probes per matched run, stops at the first mark (2026-10-31).
- Prod check 2026-09-27 (brand 75d7e3e8): billed/vendor per day = 5.000 since 09-15, 4.000 Jul–Aug.
  Unpriced = older Instantly lines costs-service states as unknown + rows before 2026-05-03.
- **Grouped twin `GET /internal/stats/costs/vendor`** — the UNDATED grouped aggregation
  (`/v1/stats/costs` org-scoped, `/v1/stats/public/costs` fleet) on the same basis, same
  pricing, same field vocabulary (`totalCostInUsdCents` billed gross, `vendor*`, `unpriced*`,
  `unpricedCostNames`) under `groups[].dimensions`. `groupBy` (required, comma list): brandId,
  workflowSlug | workflowDynastySlug, campaignId, featureSlug, audienceId (COALESCE cost row, run),
  serviceName, taskName, costName. Filters: `orgId` (absent = fleet), brandId, campaignId(s),
  featureSlug(s), workflowSlug(s), workflowDynastySlug, audienceId, serviceName, taskName,
  startedAfter/Before, costSource. INNER join on actual/provisioned/refunded rows: a group with
  none is ABSENT (all its figures would be 0) and there is no runCount. Billed totals equal the
  billed reads' per group (guarded in `vendor-cost-grouped.test.ts`). Served from the
  (campaign, run-start UTC day, org, brands, feature, workflow, cost source, status, cost name,
  billed unit price, cost-row UTC HOUR) rollup of migrations 0050 + 0051 (stamp
  `campaign_cost_items`, 59.7k groups for 2.16M ledger rows) unless the read names
  audienceId/serviceName/taskName: a group straddling a served-from instant and the bounds'
  partial UTC days are read from the ledger. Live it was 13-25 s for the cold email feature and
  500'd on the statement timeout at 3-4 concurrent reads; from the rollup ~1.2-1.8 s (2026-10-18).
  The cost-row hour is load-bearing: without it (0050) a group held up to 44 days of Instantly
  sends, 294 groups straddled a price change and their ledger re-read timed out. Parity +
  straddle: `stats-rollup-campaign-cost-items.test.ts`.
- **Margin `GET /internal/stats/costs/margin[?orgId=]`** (staff Monitoring page): platform rows only,
  one pass over `runs_costs` (no runs join; `orgId` reads the frozen 0029 org), `GROUPING SETS` →
  `{ total, providers[], costItems[] }`. Billed = CHARGED (`actual`); refunded stated apart; holds,
  cancels, BYOK in no figure. All math in Postgres: vendor rounded to scale 10 FIRST, so
  `margin + vendor == pricedBilled` exactly; unpriced never enters margin. Provider is per VERSION
  (deepseek-tokens moved vercel → deepseek): matched version's, else the name's version served at
  `created_at`, else null.
- **Monthly twin `GET /internal/stats/costs/margin/timeseries[?orgId=]`**: same CTEs (`marginCostedCtesSql`,
  shared), per provider per UTC month of the cost row's `created_at`, dense from the first row to the
  current month (`complete: false`). Each provider's months sum to its margin row FIELD BY FIELD: vendor
  is unrounded per row, so a month's vendor = round(running sum) − round(previous running sum) (telescopes
  to the margin read's rounded total; per-month rounding would drift). Pinned in `cost-margin-timeseries.test.ts`.
- **Public twin: `vendorMonthly` on `GET /public/stats/runs`** (PUBLIC-VENDOR-COST-1031, the landing's monthly spend bars at
  vendor cost): the margin monthly read summed over providers (`readPublicVendorMonthly` in `routes/vendor-costs.ts`), CHARGED
  (`actual`) platform rows only, per UTC month of the cost row's `created_at` (not the run start `monthly` uses). Per month:
  charged, vendor, unpriced + share; above 1 % unpriced the month serves vendor null + `unavailableReason`, never a mix.
  Refunded rows are out (mostly unpriced Instantly sends). 5-min in-process cache, failure not cached; a catalogue failure
  serves `vendorMonthly: null` + `vendorUnavailableReason` and the billed fields unchanged (investors page). Only the fleet
  monthly TOTAL is public, never per provider. Guard `tests/integration/public-vendor-monthly.test.ts`.
- **Units `GET /internal/stats/costs/consumption[?costNames=a,b&since=YYYY-MM-DD]`** (costs-service's real cost
  per credit of each vendor subscription = bank spend / these units): fleet-wide SUM(quantity) per UTC day of
  `created_at` × cost name × `cost_source` (platform key vs org key, never merged), SPARSE days + `totals[]`.
  Statuses = the margin read's: `actual` + `refunded` (refunded = consumed, not charged; `refundedQuantity` is
  that part). Also billed money per row (`billed*`/`netBilled*` = `actual`, `refunded*` apart, as margin). `orgId` /
  `brandId` filters + `groupBy=orgId,brandId` (org = 0029 frozen org; brand = `runs.brand_ids`, joined only when asked;
  a co-branded run counts under EACH brand). No catalogue call.

## Task units — charged runs, orgs and units per task, fleet-wide (migration 0049)

`GET /internal/stats/costs/task-units?serviceName=…[&taskNames&costNames|costNamePrefix&costSource&since&groupBy]`
(api-key, no identity headers). The Research page's typed-judgment studies (features-service): judgments
= `serviceName=chat-service&taskNames=judgments,platform-judgments&costNamePrefix=typesafe-jev-&groupBy=month,taskName,parentServiceName`;
one Apollo reveal as billed = `serviceName=apollo-service&taskNames=enrichment&costNames=apollo-credit&costSource=platform&since=2026-09-28`.
Live it was a seq scan of every run + 2 probes per judgment: 124 s in prod (2026-10-18).

- **Rollup `stats_rollup_task_units`**: (run-start UTC day, run org, service, task, PARENT run's service,
  cost name, cost source) over `status='actual'` rows only: run_count, n, quantity, gross, net. groupBy ⊆
  {month, taskName, parentServiceName, costName, costSource}; orgCount = DISTINCT over rollup rows (GROUPING
  SETS gives the scope total), never summed.
- **run_count = runs with ≥1 charged row under the key.** Trigger upserts the key row FIRST (lock), then checks
  OTHER rows of the run in a later statement (0035 lock-then-read). Summed over cost names a run counts once
  per name. Guard: `tests/integration/stats-rollup-task-units.test.ts` (ledger parity through every write,
  20 concurrent rows on one run; red if the "other row" check is dropped).
- **Readiness** stamp `task_units`; prod needs `scripts/rebuild-stats-rollup.ts task_units` after the deploy;
  the read answers 503 until then (never a live fallback: it cannot finish under the stats timeout).
- TRUNCATE fires no triggers: `tests/global-setup.ts` truncates the table too.

## Brand transfer — history moves, money does not (migration 0038)

`POST /internal/transfer-brand` (fleet contract, called by brand-service in
parallel with every other service) moves a brand's history to another org.

- **Which runs**: every source-org run whose `brand_ids` CONTAINS the brand (solo
  AND co-branded — a run carries one org, so a co-branded run follows the first of
  its brands to leave), plus untagged runs (`brand_ids` NULL/empty) whose
  `campaign_id` is one of the brand's campaigns (carried by a run tagged with the
  brand, in source or target org). Untagged runs with no campaign stay.
- **What moves with a run**: `runs.organization_id`, `runs_costs.organization_id`
  (0029 denorm) and `run_events.org_id`, each only where still on the source org.
  `org_actual_totals` and the campaign-day rollup follow by trigger. With
  `targetBrandId` the id is `array_replace`d in `brand_ids` everywhere and in the
  moved runs' `run_events.brand_ids`.
- **Chunked (500 runs/tx — 2000 was 3.7x slower: in-tx row versions of the shared total/rollup rows cannot be pruned), idempotent, concurrency-safe**: the UPDATE re-checks
  `organization_id = source` under the row lock; all figures come from the rows
  THAT chunk's UPDATE returned. A re-run moves and records nothing. Chunking keeps
  the source org's `org_actual_totals` row lock short (it is the agency's org).
- **Money**: each chunk freezes what it moved into `brand_transfer_moves` in the
  same transaction — projected (what `org-usage-total` counts) and actual (what
  `org-actual-total` counts), gross + net. `GET /internal/brand-transfers/moved-usage`
  sums it per (source org, source brand, target org); billing-service offsets it so
  both balances stay unchanged. Never recompute these figures from live rows.
- **Known edges**: silver is mutated without a per-run bronze event (the ledger is
  the audit record); an event written later for a moved run with the source org in
  `x-org-id` stays on the source org.
- `TRUNCATE` fires no triggers: `tests/global-setup.ts` truncates the ledger too.

## Feature-slug corrections — a missing slug is filled by a bronze event (migration 0044)

A writer that opens a parent run WITHOUT a feature slug leaves the whole subtree
unlabelled (children inherit), so every per-campaign cost read filtered by the
campaign's feature reads that spend as $0 (instantly-service AI Instant Call until
v0.83.35, DIS-373). `POST /internal/runs/feature-slug-corrections` (staff, api-key)
`{rootRunIds ≤500, featureSlug, reason, correctedBy}` fixes recorded history.

- **Doctrinal path, not a silver UPDATE**: one bronze `run.feature_slug_corrected`
  event per run (payload featureSlug/reason/correctedBy = the audit trail), projected
  by `project_run_lifecycle_to_silver`. The rollups keyed on `feature_slug`
  (0034, 0037/0041, campaign entries) follow by their `UPDATE OF` triggers; cost
  amounts never move.
- **Fills NULL only**: a run stating a slug keeps it (projection re-checks
  `feature_slug IS NULL`), the walk (`src/services/feature-slug-correction.ts`) does
  not descend below a run labelled with another slug (a sourcing serve keeps its
  subtree). 404 unknown root, 409 root stating another slug; idempotent.
- **Do not point it at `workflow`/`execute-workflow` roots blindly**: those are
  unlabelled by design (see "Parent-child conflicts") and a correction would move run
  counts in every feature rollup. Correct the root the faulty WRITER opened.
- Guard: `tests/integration/feature-slug-corrections.test.ts` (rollup == live after
  correction).

## Dashboard v2 reads — precomputed where a scan cannot be fast (migration 0040)

Measured in prod 2026-10-08 (owner org 91e76989, box at load ~27): staff margin
9-13 s, run-outcomes 2-24 s, Billing runs list 1.5-6.5 s, per-day cost stats
0.6-4 s. Same figures, same shapes; each read keeps its live query until its
structure is stamped in `stats_rollups`.

- **`stats_rollup_cost_day`** (stamp `cost_day`) — platform `actual`/`refunded`
  cost rows per (org, cost name, billed unit price, status, UTC day): n, Σquantity,
  Σgross, Σnet, min/max created_at. The margin reads (`marginBaseSql` in
  `routes/vendor-costs.ts`) price one row per group at its min created_at; a group
  whose (min, max] contains a catalogue served-from instant of its name is read
  row by row (`idx_runs_costs_margin_raw`, per-group LATERAL fenced by `OFFSET 0`:
  flattened, it merge-joined a sort of the whole ledger, 5 s; edges are one array per
  name, hash-joined, not a per-group EXISTS over all 1.1k instants, 1.4 s). Exact: every other group's rows sit on
  one side of every window edge, and Σ(q × vendor) = Σq × vendor in numeric.
  min/max only widen (removal keeps them), which can only send a group raw.
  Rebuild: `scripts/rebuild-stats-rollup.ts cost_day` (snapshot protocol).
- **`run_campaign_entries`** (stamp `campaign_entry`) — projection of every
  campaign's ENTRY runs (campaign set, parent not a run of the same campaign) with
  the run's current filter/outcome columns. Trigger on runs INSERT/UPDATE upserts
  or deletes the row (one parent PK probe per write); a campaign change recomputes
  the run's children; FK cascade on delete. `GET /v1/stats/run-outcomes`
  scope=entry reads it only WITH a campaign filter (no NULL-campaign rows here).
  Backfill: `scripts/rebuild-stats-rollup.ts campaign_entry` — lock-free
  one-day windows, `ON CONFLICT DO NOTHING` (a trigger-written row is newer).
- **`idx_runs_org_started`** (org window reads) and **`idx_runs_campaign_task_started`**
  (`GET /v1/runs?campaignIds&taskName&limit`: the per-member walk stops at the
  page instead of filtering ~64k runs). Built CONCURRENTLY out-of-band on prod.
- **`GET /v1/stats/costs/timeseries`** — org-scoped twin of the public timeseries:
  run count + money + min/maxStartedAt per (local `tz` day|week|month[, campaign]),
  one read for the Today chart's week instead of one `/v1/stats/costs` per day.
  Served from **`stats_rollup_org_hour`** (migration 0042, stamp `org_hour`):
  (org, brand set, campaign, UTC hour) — a local day is whole UTC hours in any
  whole-hour tz (a :30/:45 zone falls back live, checked per row). Bound hours with
  a run on the excluded side and hours with a `minmax_stale` row are read live
  (0041's rule). Only org/brand/campaign filters; anything else is live. Rebuild:
  `scripts/rebuild-stats-rollup.ts org_hour`.
- TRUNCATE fires no triggers: `tests/global-setup.ts` truncates both tables.
  Parity guard: `tests/integration/dashboard-reads-speed.test.ts` (ready vs live,
  raw bodies).

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
- `status = 'refunded'`
- `status IN ('actual','provisioned')` (== "displayed total")
- `cost_source = 'platform'`
- `cost_source = 'org'`

**Banned inline**: `status != 'cancelled'` or `status <> 'cancelled'`. The
negation form silently includes any future enum value. Use the explicit
`status IN ('actual','provisioned')` instead so a 4th status defaults to NOT
counted until consciously added — fail-safe. **That fourth status shipped:
`refunded` (migration 0033), and it landed with ZERO change to either generated
column precisely because the doctrine held.** See "Refunded costs" below.

**Shared SQL builder**: `src/services/cost-aggregator.ts` exports the canonical
SUM CASE WHEN blocks for total / actual / provisioned / cancelled / refunded / own / own-platform.
Every aggregation endpoint imports + uses these. New aggregation sites MUST
go through the aggregator — do not copy-paste inline CASE expressions.

**JS-side aggregation**: when summing in JS (children-summary), use explicit
status enumeration (`if status === 'actual' ... else if status === 'provisioned' ...`).
Never use `else` as a catch-all — that's the same mistake as `status != 'cancelled'`
in SQL.

## Refunded costs — spend that happened and that we are not charging (migration 0033)

`refunded` is the fourth cost status. It means: **this money really left the
building at the provider, and the platform has decided not to charge the customer
for it.** Neither existing status can say that — `actual` keeps charging, and
`cancelled` claims the spend never happened, which is a lie about the ledger. The
only lever before this was a billing credit grant, which misstates both sides.

Four distinct facts, never conflated: `provisioned` (a hold, not charged),
`actual` (charged), `cancelled` (never happened), `refunded` (happened, not
charged).

**The line that matters: refunded money affects the ACCOUNTING view, not the
workflow PERFORMANCE view.**

- **Accounting** ("what does this customer owe / what were they charged") stops
  counting it, and that fell out **for free** from the predicate doctrine above:
  every aggregation uses atomic status literals, never `!= 'cancelled'`, so a new
  status is ignored rather than mis-bucketed. `is_platform_projected` and
  `is_platform_committed` are UNCHANGED by migration 0033. A refunded row leaves
  `GET /internal/org-usage-total` (which billing re-derives the spendable balance
  from on every authorize) and `GET /internal/runs-expected-totals` the moment its
  status flips — so **the org's balance rises with no credit written anywhere**.
  `POST /v1/stats/budget` likewise stops counting it: a comped cost is not budget
  spend.
- **Performance** ("what did this workflow cost to produce an outcome") keeps
  counting it, through `refundedCostInUsdCents` / `netRefundedCostInUsdCents` —
  new columns on the shared aggregator (`refunded_cost` / `net_refunded_cost`),
  served by `GET`+`POST /v1/stats/costs`, `GET /v1/stats/public/costs` and its
  `/timeseries`. **Real spend = actual + refunded.** Never fold refunded back into
  the displayed total; the two views are answers to different questions.
- The run's own status is untouched. A refund is a fact about a COST ROW; putting
  money state on the run would create a second source of truth and break
  "completed means completed".

**State machine.** `refunded` is reachable ONLY from `actual`. Refunding a
`provisioned` or `cancelled` row is refused with 409 — a cost that was never
charged is cancelled, not refunded — and a cost can never be CREATED as refunded
(`CostCreateStatusEnum`). Refunding twice is a no-op: the HTTP layer returns the
row unchanged and writes NO bronze event (bronze captures state changes, not HTTP
traffic), and the projection's `UPDATE … WHERE id = … AND status = 'actual'` guard
makes even a replayed event idempotent. No amount can move twice.

**Provenance is mandatory and lives ONLY in bronze.** Every refund carries
`reason` + `refundedBy`, recorded in the append-only `cost.refunded` payload
alongside the frozen gross/net amounts. It is deliberately NOT projected onto
silver: the audit trail is where "why and by whom" belongs, and duplicating it
into the projection cache would be a second source of truth. A refund with no
motive is indistinguishable from an ordinary cancel three months later.

**Surfaces:**

- `PATCH /v1/runs/:id/costs/:costId` with `{status:"refunded", reason, refundedBy}`
  — one row.
- `POST /internal/cost-refunds/preview` then `POST /internal/cost-refunds/apply`
  (`src/routes/refunds.ts`) — the staff action. Both take the SAME filter
  (`orgId` required; optional `rootRunId` which expands to that run AND its
  descendants, `costName` / `costNamePrefix`, `serviceName`, `taskName`,
  `startedAfter` / `startedBefore`) and select the SAME set, so **what the preview
  shows is exactly what apply writes** — this writes money, and a filter that
  writes in one shot with no preview is not acceptable. Only CHARGED
  (`status='actual'`) PLATFORM (`cost_source='platform'`) rows ever match: a hold
  is a cancel, and a BYOK row is paid straight to the provider so there is nothing
  to comp. Already-refunded rows stop matching, which is what makes apply
  idempotent (a re-apply reports `refundedCostCount: 0`). Preview totals always
  cover the FULL matched set — only the row LISTING is capped at 500, flagged by
  `costsTruncated`, never silently truncated. Apply refuses above 5000 rows (422)
  so a wide filter is narrowed rather than discovered afterwards.

**No backfill, no column, no index, no read swap.** Nothing is refunded until
someone refunds something, so every existing number in this service is
byte-identical after this migration. The only schema change is the projection
trigger learning one more domain event.

**Billing invalidation.** The staff apply does not call `notifyUsage` (a
platform-level action has no `x-user-id` to satisfy billing's `requireOrgHeaders`).
That is fine and deliberate: `runs_costs` is the source of truth and
billing-service re-derives from `GET /internal/org-usage-total` on every authorize.
The per-row PATCH path keeps its existing fire-and-forget hint.

## Incurred, never-charged costs — late declaration of past spend (migration 0048)

`POST /internal/incurred-costs/preview` then `/apply` (`src/routes/incurred-costs.ts`,
internal key). Spend that really happened at the provider, that the owner decided not
to charge, and that was never declared (first caller: instantly-service, ~102k
per-email send costs of 2026-08-23 -> 10-02 that made those workflows read ~4x
cheaper on the incurred basis).

- **Born `refunded`, never `actual`.** One `cost.added` bronze event per item with
  `status:'refunded'`, so the row is in NO charge predicate at ANY instant (POST actual
  then refund would charge the org between the two calls). Counted by every incurred
  read (refunded columns, every rollup). No billing notify (nothing chargeable moved).
- **Dated.** `incurredAt` rides in the payload; the projection writes it as the row's
  `created_at` (0048: `COALESCE(payload incurredAt, occurred_at)`, no other change, no
  pre-0048 payload carries it). Bronze `occurred_at` stays = when we recorded it.
  Run-dated reads use the run's `started_at` as for any cost. Refused (invalid): future
  instant, instant before the run started, unknown run, duplicate key in the body.
- **Priced like a live write**: costs-service platform price of each name resolved
  now, x quantity; net frozen with the org's current usage discount. Platform only.
- **Audit**: `reason` + `authorizedBy` + `origin:'incurred_uncharged'` in the payload.
- **Idempotent** per `(runId, idempotencyKey)` (key mandatory, same per-run unique index
  as live writes); an existing row is `already_recorded` whatever its status. A
  concurrent duplicate (23505) re-classifies. preview and apply share `classify`.
- **Batch**: <=500 items, one statement in one transaction on `db` (short rollup-row
  locks). Apply 422s with the per-item list if any item is invalid, writing nothing.
- Guard: `tests/integration/incurred-costs.test.ts` (charge reads byte-equal before /
  after, refunded columns + cost-day rows on the stated days, rollup vs live).

## Outcome occurrences — the production-cost ledger (migration 0057, COST-ACCOUNTING-1023)

Owner 2026-10-23 (doctrine: agent-config skill `cost-accounting`): runs-service is the general ledger of what each
outcome costs to PRODUCE; a run is a PRODUCTION ORDER. features-service only reads it (graph rollup, A/B, estimates);
billing stays imputation (who pays). Rejected, do not reintroduce: an accounting-service, billing as ledger, a "unit"
concept, a value-based joint-cost split.

- **Declare**: `POST /v1/runs/:id/outcomes` (x-org-id = the run's org, else 409 `run_org_mismatch`) and
  `POST /v1/platform-runs/:id/outcomes`, body `{produced?: [{outcomeKey, subjectService, subjectId, quantity?}],
  consumed?: [{outcomeKey, subjectService, subjectId}]}`, <= 1000 per call. Keys = features-service catalogue steps
  (`GET /public/catalogue/steps` rows[].key, Positive reply = `conversation`), checked on every call
  (`services/outcome-catalogue.ts`, 5 min cache, one re-read on a miss): unknown = 400 `unknown_outcome_key`,
  catalogue unreadable = 502, never accepted blindly; `email_sent` stored as `message_sent`. Idempotent per (run, direction, key, subject); same occurrence with another quantity = 409; immutable item by item (see "Taking a declaration back").
  Bronze `outcome_declaration_events` -> trigger -> silver `run_outcomes`, as every lifecycle. Optional: a run that
  states nothing reads byte for byte as before.
- **Allocation v1** (`ALLOCATION_VERSION`, served on every read; a change = v2, never an edit): each actual +
  refunded cost row goes to its nearest run (self or ancestor) with a produced occurrence; per (that run, UTC day,
  org) split by quantity with CUMULATIVE rounding at 10 decimals (shares telescope to the exact total); same split on
  gross, frozen net, vendor actual (+ unpriced gross apart). No such run = "produced none".
- **Allocation v2 = v1 + cross-run normal loss (migration 0066, 2026-10-24, doctrine rule 2)**: a cost row with no anchor, no
  support mark on its walk and a workflow slug W on its run (a follow-up that judged "later", a run the funnel cap stopped) is LOSS
  of pipe W; per (UTC day of the cost row, cost org, W) it is split as rule 2 over the occurrences PRODUCED that day by runs of W
  in that org (declared_at, the run's org; occurrence-id order). W produced nothing there that day = it stays undeclared. Pools
  stored per day (`cost_loss_pool_days`) so the per-occurrence read adds the same shares (Σ occurrences == allocated);
  `cost_ledger_days.loss_*` = the part of allocated that is loss, served as `normalLoss` on ledger-check. A NULL workflow never
  pools: a declaration gap stays visible as undeclared. v1 rows are kept, every day recomputes under v2.
- **Allocation v3 = v2 with the loss pool keyed on the CAMPAIGN (migration 0069, LEDGER-HISTORY-1024-RUNS)**: pool = (UTC day, cost org,
  workflow W, campaign C, NULL = no campaign); v2 moved campaign A's loss onto campaign B's units of the same workflow. A campaign that
  produced nothing on W that day keeps its loss as produced-none under its own tags (= `unpooledLoss` on the reconciliation; features
  pools it on the pipe's output). `outcome_cost_days` also carries the row's run's `audience_id` / `service_name` and the producing
  run's `source_audience_id` (dims `audienceId`, `serviceName`, `sourceAudienceId`); 'none' rows: n = distinct spending runs.
- **Allocation v4 = v3 with the pool keyed on the run's TASK when it has no workflow (migration 0072)**: pool key =
  `workflow:<slug>`, else `task:<service>/<task>`; per (UTC day, cost org, pool key, campaign). A crm judging run that kept nothing
  (no workflow, no campaign) rides the same task's lead_identified that org-day; only a pool that produced nothing that day stays
  produced-none (`unpooledLoss` when it carries a workflow, else `undeclared`). `cost_loss_pool_days.pool_key`.
- **Allocation v6 = v5 with a no-workflow cost row's LOSS keyed on its walk-end run**: a run with no workflow (a chat-service
  `complete` child of human-service's audience-refill) takes the pool key + campaign of the run its walk ended on (its production order)
  for rule 4b, never its own task (`loss_keyed` CTE): was undeclared beside the order's units that org-day (belgrade-v10, 2026-10-25).
  No migration. A pool with no unit that day is unpooled LOSS when its (org, pool key) is a known PRODUCTION LINE (produced on or
  before that day: `pool_lines`, migration 0079, trigger on run_outcomes + one-time fill `ensurePoolLines` in the refresher, 27 s,
  stamp `pool_lines`; `outcome_cost_days.loss_line`), else UNDECLARED (a line that never produced = a producer that never declared).
  crm-service's registry Jev that identified nobody on most org-days read undeclared before (2026-10-25).
- **Loss shares stored per occurrence (migration 0075, LOSS-SHARE-STORED-1024)**: the day statement also stores each produced
  occurrence's share of its pool (`cost_loss_occurrence_days`, flag `cost_ledger_computed_days.loss_occurrences`), and the
  per-occurrence read (`occurrenceCostSlices`) serves it by occurrence id. A day without the flag (stored before 0075) is ranked
  live (one runs PK probe per produced occurrence of the day: 64k probes for 150 runs, 35 s at load ~50, a 500 on the 30 s timeout,
  2026-10-24) and recomputed by the refresher AFTER every missing / stale day; the flag is not part of day completeness, so no other
  read moves. Guard: `tests/integration/ledger-reconciliation.test.ts` (v4 test: stored == live body).
- **Anchor spend stored per day (migration 0080, OCC-READ-ANCHOR-SPEND-1025)**: the day statement also stores each anchor's
  spend per cost org (its `g`: `cost_anchor_spend_days`, flag `cost_ledger_computed_days.anchor_spend`). `listOccurrences` passes
  `storedSpend`: an anchor whose EVERY UTC day from its start to today is flagged, each computed after the anchor started AND
  declared its first produced occurrence, is priced from those rows and NEVER walked (a newsletter with 18,250 children walked
  > 30 s: every read whose consumption resolved to one of its sends 500'd, 2026-10-25); any other anchor is walked live. Served
  as of the day's last computation (≤ one refresher tick), like the loss shares. The refresher's own `standardCostsOf` stays
  live. Unflagged days recompute last. Guard: `tests/integration/occurrence-anchor-spend.test.ts` (stored == walked body, a
  stored anchor is not walked, flag off / late anchor = live).
- **Standard cost on reuse** (owner 2026-10-23): a consumption resolves to the latest produced occurrence of the same
  (key, subject) declared at or before it (else the earliest later), among those declared before the end of the
  consumption's UTC day. The first consumption is paid by the spend; every later one is charged the same production
  cost as an explicit **reuse gain** (consuming org, consumption day). No producer = unknown provenance (counted).
- **Reads (service-auth)**: `GET /internal/outcome-occurrences` (cost per occurrence, the declaring run's tags, the
  consumption's source + standard cost), `GET /internal/outcome-costs/ledger-check` (per (day, org), exact:
  standard - reuseGain + producedNone == ledger on every basis), `GET /internal/stats/outcome-coverage` (stored daily
  series, fleet / service / task: the dashboard v2 Monitoring chart reads it).
- **Stored days** (`cost_ledger_days`, `outcome_coverage_days`, `cost_ledger_computed_days`): in-process refresher
  (`startCostLedgerRefresh`, first tick ~60 s after boot, every 15 min, single flight), days one by one within a 10-min budget
  per tick: today always and the 2 days before once their figures are > 1 h old (`recentDaysDue`: all 3 every tick ate ~9 of the 10
  min at ~3 min/day and the history never converged, 2026-10-24), then days NEVER computed back to the FIRST DAY OF SPEND (2026-02-02 in prod; 60 days on an
  empty db), then days a declaration RECORDED after them moved (see "Backfill"), each newest first. Missing before stale: during
  backfills the newest days are stale every tick, and a date-only order starved the history (8 of 265 days stored, 2026-10-23). `computed_at` = the read transaction's now(). A day is
  ONE read-only statement on the stats pool with its own 900 s timeout: on the loaded box of 2026-10-23 a day's ~25k
  cold run PK probes took minutes. A failed day never blocks the others.
- Guards: `tests/integration/outcome-ledger.test.ts`, `tests/unit/outcome-ledger-check.test.ts`.

## Lead states — allocation v5 (migration 0076, LEAD-STATES-1024-RUNS)

Owner 2026-10-24 (doctrine rules 2 and 3, skill cost-accounting): a lead outcome is a STATE reached once per lead x brand;
a run acting on a lead pays the NEXT state that lead had not reached at the run's START, in each family (interest:
lead_interested < meeting_booked < meeting_attended < paid_client; visit: lead_visited, never summed); spend past the target
is ABNORMAL loss, in no unit cost (IAS 2 section 16). `src/services/lead-states.ts` (inputs) + `stateRoutingSql` (day statement).
- **Inputs, never re-typed**: step -> state from features-service `/public/catalogue/steps` (`leadState`, `leadStateFamily`,
  `leadStateRank`; conversation/form/signup/booking_call -> lead_interested, website_visit -> lead_visited); a run's pipe target =
  its channel (feature slug) x the leg its workflow dynasty is assigned to (features `/internal/workflow-leg-assignments`, active
  else latest; dynasty from workflow-service `/public/workflows`, a merged dynasty on its survivor's leg) -> the leg's `to` step
  on `/public/channels` -> its state. First reaches from lead-service `GET /internal/lead-states` (real instants), synced each
  refresher tick into **`lead_state_reaches`** (brand x lead x state; a changed/removed reach stamps `changed_at`, removed =
  `removed_at`, never deleted; `reached_at` NULL = reached, date unknown: no unit, no reach). Unreadable input = the tick fails
  (no day computed on a guess). Catalogue/pipe changes are not staleness-tracked (like the vendor catalogue); reach changes are:
  a day >= the lead's first declared occurrence (or its run's start) computed before `changed_at` is stale.
- **Routing (per v4 share, own and 4b loss shares alike)**: an occurrence whose subject is a lead (`lead-service`), whose key
  reaches no state (message_sent, lead_found, message_written...) and whose anchor run's (workflow slug, feature slug) has a
  target leaves the occurrence ($0 by-product) and goes, per family, to the next state the lead had not reached at the anchor's
  `started_at` (reaches at ANY of the run's `brand_ids`): PRIMARY family (the target's) = the ledger: target already reached ->
  abnormal `target_already_reached`; else the lead's later reach of the next state (the UNIT, `lead_state_reaches.id`); else
  STATE LOSS of (cost org, pool key, campaign, state), split equally over that day's units of the same key (unit-id order,
  cumulative rounding); no unit -> produced none under the paying run's tags (reads as unpooled loss). Other family =
  `parallel_cost` / `parallel_none` rows (a state's own price = produced_cost + parallel_cost of its key). A share of an
  occurrence a run of the same (service, task, campaign) already produced for the same subject = abnormal `repeat_production`,
  whatever the pipe. Everything else = v4 byte for byte.
- **Check**: allocated + producedNone + abnormal = ledger (per (day, org), every basis). `cost_ledger_days.abnormal_*` +
  `abnormal_by_reason`; ledger-check rows/totals `abnormal`, `abnormalByReason`, `outcomeSpendCoverage` = (allocated + abnormal)
  / (ledger - support); reconciliation part `abnormalLoss` (+ `abnormalByReason`); outcome-costs `scope[].abnormal`, sections
  `abnormal` (dimensions + `abnormalReason`) and `parallel`. produced_count rows for states = reaches dated that UTC day.
- **Per-occurrence read**: a re-routed occurrence reads cost $0 (its share is on the state, stored days only); a consumption by
  a re-routed run counts under the state it rides (`consumingOutcomes`), null when abnormal.
- **State inputs = the lower state (migration 0078, `state_ladder`)**: each first reach of a state ranked r > 1 CONSUMES that lead x
  brand's reach ranked r - 1 ('consumed' row, no money: priced at the lower state's unit cost by the reader's rule-4 rollup; meeting =
  interested leads it took + its own follow-ups). A DECLARED occurrence of a state key (lead-service `outcome-recording` meeting_booked)
  is evidence: never a unit in produced_count, its consumptions dropped. Ledger money unchanged: only outcome-costs lists a day stored
  without the stamp in daysMissing.
- **A pipe takes in the lower state of EVERY lead it works on (migration 0082, `state_inputs`; owner: « meeting = 100 interested x
  $148 + $500 of follow-ups, / 10 »)**: a consumption of a lead-service subject by a run whose pipe targets a state counts, as consuming
  outcome, the next state that lead had not reached (null = abnormal) and, as consumed outcome, the state the consumed step reaches
  (conversation -> lead_interested), ONCE per lead x consuming state (a later consumption by a pipe aiming at the same state is dropped);
  the 0078 ladder row of a reach is kept only when no such pipe took that lead's lower state in. So the leads that never booked feed the
  meeting price as transferred-in normal loss.
- **Weighted-average price per pipe (migration 0083, LEDGER-PIPE-WEIGHTED-AVERAGE-1027; owner 2026-10-27: « of course you take that
  cost in the price of building outcomes », by the book = process costing per production line)**: the day statement's per-(day,
  campaign) pools are a storage grain, never the price. A 'none' row of a pipe's spend carries `pipe_target` (its lead's next state,
  else the pipe's leg step, from features' leg assignments: `pipeSteps`), and `pipe_unit_days` stores each unit a pipe's spend
  reached per day (channel x outcome). outcome-costs `pipes[]` = per (channel, outcome) over the range: cost + pooledLoss over
  DISTINCT units; ledger-check `pooledLoss` = the part of produced-none carried by a pipe that has units in the range, counted in
  `outcomeSpendCoverage`. A pipe that produced none of its outcome keeps unitCost null; its loss rides that outcome's units from the
  other pipes (counted in pooledLoss), only an outcome nobody produced stays uncovered. Days stored before the stamp
  (`pipe_units`) are recomputed; only outcome-costs lists them missing.
- **A run that kept nothing still acts on a lead (`cons_of`)**: a cost row with no anchor and no mark whose walk reaches a run of a
  pipe with a state target that declared CONSUMING a lead-service subject (the pipe's from-step: a "not now" follow-up, a cap
  refusal) is routed like a production share, split over the leads that run consumed (`via_consumption`): the meeting pipe's
  follow-up after the yes pays meeting_booked, a cold email "not now" after the yes is abnormal. Runs that declare no lead at all
  (ai-meeting-booking execute-workflow "not now" runs, ~$34 of chat-service writes before 2026-10-25) stay unpooled loss until their
  producer declares the lead (workflow-service brief LEAD-STATES-1024-MEETING-WRITES); those declarations stale the days they move.
- **Only OUR factory's reaches are units (migration 0084, OUR-FACTORY-OUTCOMES-1027; owner 2026-10-27: « as close as possible to
  industrial cost-accounting best practice », no case per source/brand/channel)**: lead-service serves WHOSE WIN each reach was
  (`causedByOutreach` true / false = another factory: client CRM, team, site, before our first touch / null = no proof, + `causeReason`),
  stored on `lead_state_reaches`; a reach served without it fails the tick (never read as "not ours"). Units (`produced_count`), the
  unit a run's spend reaches, and the ladder input count `caused_by_outreach IS TRUE` only; another factory's lower state taken in by
  our pipe is FREE-ISSUE material ($0, no input row); "already reached" (abnormal) still reads every reach. A whose-win change stamps
  `changed_at` and stales the reach's own day. Days stored before (`cost_ledger_computed_days.our_factory`) recompute with the ladder
  ones; only outcome-costs lists them missing. Prod 2026-10-27 since 2026-02: interested 274 -> 72, booked 79 -> 11, paid 25 -> 5.
- Tests default to the served step map and NO pipe target (`tests/setup.ts`), so every other test reads v4. Guard:
  `tests/integration/lead-states.test.ts` (Marie: send before the yes -> unit, after -> abnormal, non-answers ride the yes,
  visit priced apart, a moved reach stales the day).

## Ledger reconciliation — `GET /internal/outcome-costs/reconciliation` (LEDGER-HISTORY-1024-RUNS)

The gate every ledger reader switches on (owner 2026-10-24: all readers at once, the day it reconciles). Fleet-wide, per UTC day
from the first day of spend (default) to yesterday: spend = declaredProduction + normalLoss + unpooledLoss + undeclared + support,
exact on every basis, with shares; `services[]` (per SPENDING service: undeclared + runs, unpooled loss, support), `provenance[]`
(per consumed key x consuming service: unknown provenance). `reconciled` = balanced (parts == spend, every (day, org) check, the two
stored produced-none sources agree) AND complete AND declarationsComplete (no undeclared, no unknown provenance). Stored rows only.
- **Stale days** (`staleComputedDays`): a stored day computed before a fact recorded since (declaration incl. backfill, support mark,
  void/unmark, spend landing on a past day: a `cost.materialized` or incurred `cost.added` whose row is dated before the event's day,
  3,255 late materializations in the week to 2026-10-24) is listed in `daysMissing` AND `daysStale` on every ledger read (ledger-check,
  outcome-coverage, outcome-costs, reconciliation), so `complete` is false and its figures stay out of the totals until recomputed.
  The full scan runs in the refresher's tick (`persistStaleDays`: `cost_ledger_computed_days.stale` + `cost_ledger_stale_sweeps.swept_at`,
  taken before its reads); a read adds only facts recorded after `swept_at`, never a backfill's whole history.
- **unattributed** (migration 0071): real production its OWNER marks `unattributed_production` through the support-mark doors (no pipe,
  subject never recorded, e.g. Feb 2026 runs from before campaigns): its own line on the reconciliation (totals/days/services), never
  support, never undeclared, never spread; never inferred from a missing campaign. `declarationsComplete` = complete AND no undeclared AND
  no unknown provenance (never vacuous over missing days).
- **Owner-stated repeat (migration 0081, owner 2026-10-25)**: mark kind `repeat_production` through the support-mark doors =
  work its OWNER states redid what was already done (lead-service relationship-sweep re-judging relations crm-service already
  identified). The day statement moves it from produced-none to ABNORMAL (`abnormalByReason.repeat_production`, 'abnormal' rows):
  never support, never a second producer of the same occurrence, in no unit cost.
- **services[] names who OWES the gap (migration 0077)**: `outcome_cost_days.owner_service_name` = the service of the run the
  spending run's walk ENDED on (top run, or the mark/anchor it stopped on); a chat-service call made for crm-service's people.build is
  crm-service's undeclared spend (was read as chat-service's, $15.45, 2026-10-25). Days stored before it are in daysMissing until
  recomputed (`cost_ledger_computed_days.owner_service`). The read runs in its own transaction, 120 s budget (30 s timed out at load 53).
- Guard: `tests/integration/ledger-reconciliation.test.ts` (red if the campaign key is dropped from the pool).

## Subject equivalence — one occurrence, two subject spaces (migration 0073, SUBJECT-EQUIVALENCE-1024)

`POST /v1/platform-runs/subject-equivalences` (owner door, x-service-name = every item's `subjectService`): "my subject X is the
same subject as Y" (transactional-email-service: subscriber S == lead-service lead L). The consumption resolver matches a consumption
to a production under the CANONICAL subject (the target, else itself) or any subject stated equivalent to it, and reuse ranks across
both spaces. Never inferred. One hop (a target is never a source, a source never a target), immutable rows (the table is its own log;
another target = 422 `conflicting_target`). A new equivalence re-stales every stored day from the first day either subject was
declared. Guard: `tests/integration/ledger-reconciliation.test.ts` ("SUBJECT-EQUIVALENCE-1024").

## Taking a declaration back — `POST /v1/runs/:id/outcomes/void` (migration 0059, RUNS-VOID-1023)

A declaring service that stated outcomes on a run in error (lead-service 2026-10-23: two `outcome-recording` runs each PRODUCED
several keys and consumed their own, a cost loop) takes back the run's WHOLE declaration, both directions, then re-declares on NEW runs.
- **Owner only**: `x-service-name` must equal `runs.service_name` (else 403 `not_run_owner`; absent = 400). `/v1/runs/...` also needs the
  run's `x-org-id` (409 `run_org_mismatch`), `/v1/platform-runs/...` as declare. Body `{reason, voidedBy}`, both required.
- **A void is a bronze fact, the projection removes silver**: one `outcomes.voided` event (reason, voidedBy, the removed rows,
  `affectedFromDay` = first UTC day of the run's start / its declarations), the trigger DELETEs the run's `run_outcomes`. Every read is
  on silver, so the occurrences count in NO figure with no filter added anywhere; bronze keeps declaration + void (audit, replayable).
- **Final**: a voided run accepts no new declaration (handler 409 `run_outcomes_voided`; the projection RAISEs on a racing write).
  Idempotent: a second void = 200 `already_voided`, nothing written. No item-level void: re-declare the right facts on a new run.
- **Versioning**: the allocation RULE is unchanged (still v1); a void changes the FACTS. A stored day recomputes from current silver,
  so the refresher (`daysToCompute`) marks every computed day >= `affectedFromDay` of a void newer than its `computed_at` stale. A
  pre-void figure is reproducible from bronze (replay without voids after T); never edit a stored day by hand.
- **Scoped void (migration 0074, SCOPED-VOID-1024)**: body `scope: {direction, outcomeKey}` takes back only those rows of the run
  (bronze `outcomes.voided_scoped`, projection deletes exactly the listed ids); the rest stays and the run stays OPEN to a corrected
  declaration (only a whole-run `outcomes.voided` is final). Matching nothing = 200 `nothing_to_void`. Re-stales days like a void.
- **Declarer void (DECLARER-VOID-1024)**: a scoped void takes back only rows the CALLER declared (`outcomes.declared.source_service`
  = x-service-name, matched on the row id), owner included: no service ever voids another's rows. So a NON-owner that declared on the run
  may scoped-void (content-generation-service on workflow's `execute-workflow` runs, 58,885 declarations in prod 2026-10-24) and re-declare
  on the same run; a non-owner with no declaration there = 403 `not_run_declarer`; whole-run void unchanged (owner only, 403 `not_run_owner`).
- Guard: `tests/integration/outcome-ledger.test.ts` ("RUNS-VOID-1023").

## Backfill — declaring the outcomes of PAST runs (migration 0060, COST-BACKFILL-1023-RUNS)

Owner 2026-10-23: every spending service re-reads its own history and declares the outcomes on the past runs that paid for them
(« pour être à 100 % now »). Through today's door a lead found in August and declared today cannot be the input of an August send:
resolution keys on declaration time.
- **`occurredAt`** on both declare doors and on **`POST /v1/platform-runs/outcomes/batch`** (≤ 500 runs, ≤ 1000 occurrences, per-run
  `occurredAt`; all or nothing: unknown / voided / other-org / out-of-bounds run = 422 `invalid_runs` with the list, nothing written).
  `run_started_at` = the run's start; an ISO instant must be in [run start, now] (400/422 `invalid_occurred_at`). Absent = on time.
- **`run_outcomes.declared_at` IS the effective time** (payload item `declared_at`, else the bronze `occurred_at`); every rule keys on it
  (resolution, reuse rank, the day an occurrence counts on). `recorded_at` = the bronze `occurred_at`; NULL on pre-0060 rows (all on
  time), so reads use `COALESCE(recorded_at, declared_at)` (expression index `idx_run_outcomes_recorded`, no boot UPDATE). Cost always
  lands on its cost rows' UTC days.
- **Allocation rule unchanged (v1)**: a backfill adds FACTS. The refresher recomputes every stored day ≥ LEAST(effective declaration,
  run start) day of an occurrence recorded after the day's `computed_at` (one grouped read); the same declarations recompute byte for
  byte (tested). Idempotent: a replay is `already_recorded`, nothing written; a recorded occurrence keeps its stored time.
- **Re-date (migration 0061)**: batch entry `redate: true` + `occurredAt` moves occurrences of that run ALREADY recorded with a
  LATER effective time EARLIER to `occurredAt` (status `redated`; never later). Owner only (x-service-name = run's service, else 422
  `not_run_owner`). One bronze `outcomes.redated` event per run (id, new + previous time); the projection updates `declared_at` and sets
  `recorded_at` to the re-date instant so the refresher recomputes the moved days. First user: instantly-service's 79k sends of
  2026-05-17..10-22 declared through today's door on 2026-10-23 before `occurredAt` existed.
- **Support marks (migration 0062)**: see "Support spend, named and reported apart" (0064).
- Guard: `tests/integration/outcome-backfill.test.ts`.
- **Recorded past facts (migration 0068, MEETING-DATED-OCCURRENCES-1024-RUNS)**: a SPEND-FREE run (no `runs_costs` row, no child
  run; lead-service's `outcome-recording`: a meeting booked in May recorded today) may state `occurredAt` at ANY past instant, before
  its own start (`effectiveDeclaredAt` `spend_free` -> `beforeStart`), on both declare doors, the batch and a `redate`; only the run's
  own service (x-service-name; 403 / 422 `not_run_owner`). A run with spend keeps the [start, now] bound. 0068's triggers hold it
  whatever the write order: a DATED occurrence (declared_at < recorded_at) before its run's start is refused on a run with a cost or a
  child (`outcome_before_run_start`), and such a run takes no cost and no child (409 `run_holds_dated_facts` on the cost/run doors).
  On-time rows (declared_at = recorded_at, or recorded_at NULL) are never caught by a clock difference. Redate moves only the listed
  occurrences: one batch call per instant. Guard: `tests/integration/outcome-dated-facts.test.ts`.
  The guards compare at MILLISECOND precision (migration 0070): `runs.started_at` holds µs, every stated time arrives in ms, so
  `run_started_at` on a run with spend was read as 548 µs before its start (400 on every workflow-service backfill, 2026-10-24).

## Support spend, named and reported apart (migrations 0062 + 0064 + 0065, COST-SUPPORT-1024-RUNS)

Doctrine (cost-accounting skill "Not outcomes ... Support functions, reported apart"): spend that produces no outcome BY DESIGN
is named and stated apart, so coverage reads on outcome spend only: declared / (ledger - support). Never inferred from a cost name.
- **A mark names its support function** (`run_support_marks.kind`, enum `SUPPORT_FUNCTIONS` in `schemas.ts`): `payment_fees`,
  `brand_setup`, `copilot`, `platform_llm` (judgments / LLM calls made for no caller run), `staff_experiment`, `product_feature`
  (onboarding, product reads), `retired_product`. The anchor walk stops at a marked run: its cost and its non-declaring subtree's
  never ride an outcome (a judgment made FOR a caller's run is that run's child and rides its outcome: never mark it).
  Bronze `run.support_marked` -> `run_support_marks`; idempotent (first function stays until undone); a marked run produces nothing
  (409 `run_marked_support`); a declaring run is never support.
- **A mark can be undone (0065, owner 2026-10-24: a retired product may come back)**: staff `POST /internal/runs/support-marks/unmark{,/preview}`
  (runIds, or serviceName and/or featureSlugs + kind/tasks/window/topLevelOnly), owner `POST /v1/platform-runs/support-marks/unmark/{preview,apply}`.
  One bronze `run.support_unmarked` per marked run (kind removed, reason, unmarkedBy, `affectedFromDay` = run start day); the projection
  DELETEs the silver mark, the run declares again and can be re-marked. Bronze keeps both events. The refresher reads unmark events
  like voids (every stored day >= affectedFromDay computed before the event is stale).
- **Doors** (`src/services/support-marks.ts`): at creation, body `support: {kind, reason}` on POST /v1/runs + /v1/platform-runs (same
  transaction, markedBy = serviceName); owner bulk `POST /v1/platform-runs/support-marks/{preview,apply}` (x-service-name = owner: its
  own runs only, by runIds (all or nothing, 422 `not_run_owner`) or selection: taskNames, start window, topLevelOnly, withSpendOnly;
  declaring runs left out and counted; preview shows `onOutcomeNowCount` = runs whose cost rides an ancestor's outcome today;
  `offAncestorMarkOnly` leaves out runs whose cost already stops on an ancestor's MARK, counted in `leftOnAncestorMarkCount`); staff
  `POST /internal/runs/support-marks{,/preview}` (any service: runIds, or `serviceName` and/or `featureSlugs` = a product whatever
  service ran it; `offOutcomeOnly` leaves out runs whose cost rides an ancestor's outcome today, counted in `leftOnOutcomeCount`). <= 50,000 runs per apply (422
  `too_many_runs`). The selection seq-scans `runs` (no service-first index, ~9 s), own 300 s timeout.
- **Reads**: produced none = support + undeclared. ledger-check rows + totals: `support`, `supportByFunction`, `undeclared`
  (+ totals `outcomeSpend`, `outcomeSpendCoverage`); outcome-coverage points: `support*Cents`, `supportByFunction`,
  `outcomeSpendCoveragePct`; outcome-costs scope: `support`, `supportByFunction`, `undeclared`, `outcomeSpendCoverageShare`. Stored
  per day (`cost_ledger_days.support_by_function`, `outcome_coverage_days.support_by_function`, `outcome_cost_days.support_function`
  on 'none' rows); `cost_ledger_computed_days.support_split = false` (day stored before 0064) = recomputed by the refresher and
  listed in `supportDaysMissing`. Allocation rule unchanged (v1).
- **Retired products** (no owning repo): marked by staff as `retired_product` through the staff door (legacy `google` serper
  queries Mar..Jul 2026, 51,464 runs $213.50; `emailgeneration-service`, 330 runs $2.55); `apollo/angel-round-enrich` (2026-10-01, one
  staff run, $148.21) = `staff_experiment`. All marked 2026-10-24. Preview `onOutcomeNowCount` is null when `tooMany` (not computed).
  Owner-deprecated products (2026-10-24, may come back): features `pr-cold-email-outreach`, `pr-expert-quote-outreach`,
  `pr-expert-quote-opportunities` (featured publishing), `ai-visibility-scoring`, marked `retired_product` by featureSlugs +
  withSpendOnly + offOutcomeOnly (spend already on an outcome stays): $791.30 / $271.14 / $15.85 / $295.07. Their FEATURE-LESS runs
  (feature_slug NULL: every run of `ai-visibility-score-service`, `journalists-service`, `journalists-quotes-service`, api-service
  `POST /v1/content/generate-expert-quote-pitch`) marked by serviceName, no spend filter (a parent covers its chat/scraping
  children). Press kits ARE retired (no container since the 2026-08 box migration, api-service v0.98.0 removed the routes, last
  generation 2026-04-02): its 29,042 runs marked `retired_product` 2026-10-24 by its owner door. Never mark live production.
- **One answer on every read**: ledger-check, outcome-coverage and outcome-costs read the same stored day rows, so at one instant they
  agree to the cent (prod 2026-10-24). Two figures captured minutes apart while marks are applied (`supportComplete: false`, days
  recomputing) differ: compare reads taken together, after `supportComplete`.
- Guard: `tests/integration/support-functions.test.ts`.

## Outcome ledger as totals — `GET /internal/stats/outcome-costs` (migration 0058, COST-ACCOUNTING-1023-P2)

features-service's per-outcome cost rollup (unit cost = own cost per occurrence + Σ inputs per occurrence x input unit cost)
reads TOTALS, never pages occurrences. Stored per UTC day by the ledger refresher, same computation as the ledger check
(`outcome_cost_days`; `cost_ledger_computed_days.outcome_costs` = the day holds them, a day stored before 0058 is recomputed).

- **Kinds / grain**: `produced_count` (occurrences DECLARED that day, declaring run's tags), `produced_cost` (v1 shares of the
  day's spend: cost row's UTC day + cost row's org, declaring run's tags), `consumed` (consumptions declared that day per
  (consuming outcome, consumed outcome), consuming run's tags), `none` (spend no declaring run carries, spending run's tags).
- **Consuming outcome** = produced key(s) of the consuming run's anchor (rule 1); several keys = quantity-weighted split,
  cumulative rounding (weights sum to exactly 1, `splitConsumption`); no anchor = null. Served per row on the occurrence read
  (`consumption.consumingOutcomes`), and `costSlices` (per day x cost org) on produced rows: totals == Σ occurrence rows, exact.
- **Dimensions**: outcomeKey, day, orgId (run's org), costOrgId (cost row's org = ledger check's), brandId (unnested: each brand),
  campaignId, workflowSlug, featureSlug. `costOrgId,day`: produced + none == ledger check `ledger`. Cap 5000 groups per section
  -> 422 `too_many_groups`, never truncated. Consumed standard cost = live production cost at compute time (recent 3 days recomputed).
- **Source dimensions (migration 0063, P4)**: `sourceOrgId|sourceBrandId|sourceCampaignId|sourceWorkflowSlug|sourceFeatureSlug`
  group the CONSUMED section by the run that PRODUCED the consumed occurrence (a positive reply declared on an untagged
  per-org-day reply-judging run is priced per the send's workflow / campaign / brand). Stored on each consumed row
  (`source_*`, NULL = unknown provenance, still counted in unknownProvenance); produced/scope ignore them. Days computed
  before 0063 (`cost_ledger_computed_days.consumed_sources = false`) are recomputed by the refresher and listed in
  daysMissing for a source read until then. Sums over source groups == the read without them (tested).
- **When dimensions (migration 0067, SWITCH)**: `runStartDay` (every section: UTC start day of the row's run = declaring run for
  produced, consuming run for consumed, spending run for none) and, consumed only, `sourceDay` (UTC day the consumed occurrence was
  declared = the send a reply answers) + `sourceRunStartDay` (its producing run's start day). Filters `runStartUntil` (every section),
  `sourceDayUntil` / `sourceRunStartUntil` (consumed only), inclusive UTC days: features' MATURE cut = produced `runStartUntil` + consumed
  `sourceRunStartUntil`. `day` is NOT the run start (produced cost: cost row's day; count / consumed: declaration day). Days stored
  before 0067 (`cost_ledger_computed_days.start_days = false`) recomputed by the refresher, in daysMissing for a when-read until then.
  Guard: `tests/integration/outcome-cost-start-days.test.ts`.
- Guard: `tests/integration/outcome-cost-totals.test.ts` (red if a cost-org or split is wrong; writers shard).

## A platform run made on behalf of a caller's run (`body.parentRunId`, COST-ACCOUNTING-1023-P1)

chat-service serves platform LLM calls / judgments to other services (instantly's reply classifier...). `POST /v1/platform-runs`
takes an optional **body** `parentRunId` (an org run or a platform run): the new run is that run's CHILD, so its cost counts in the
parent's subtree and rolls into the nearest declaring ancestor (ledger v1). **Nothing is inherited** (org, user, brands, campaign,
workflow, attribution): the child keeps only what its own request states, so a platform child of an ORG run stays org-less and
platform-billed (`runs_costs.organization_id` NULL, outside org-usage-total / org-actual-total / no-campaign totals). The outcome
ledger groups by the COST ROW's org, so that spend sits in the NULL-org slice of the anchor's occurrences and every per-(day, org)
check still balances. Body, not `x-run-id`: several callers (cloudflare-service, ahref...) already forward `x-run-id` to platform-runs
and it has always been ignored; binding it would re-parent them. Unknown parent = 422 `parent_run_not_found` (never a root);
stated `x-org-id` != parent's org = 409 `parent_org_mismatch`; absent = root, as before. Guard: `tests/integration/platform-run-parent.test.ts`.

## `/health` answers about the pool, and never queues behind it

`/health` runs `SELECT 1` through the same postgres.js pool as the cost
aggregations, so a saturated pool used to make the route HANG rather than report
anything. That is the worst possible failure for a health route: the fleet
health watchdog on the box probes with a 10s timeout and records `ERR`, which is
the same thing it records for a dead container — so "the pool is busy" and "the
service is gone" were indistinguishable, and the mail it sends says nothing
about which.

- **The probe is raced against a 2s budget** (`src/routes/health-probe.ts`).
  Fast → `200 {database:"ok"}`. Rejected → `503 {database:"unreachable"}`. Still
  running at the budget → `503 {database:"slow"}`, which is the new state and
  the whole point: it names pool saturation instead of hanging. The abandoned
  query keeps running on its own connection and its rejection is caught, so it
  cannot surface later as an unhandled rejection.
- **`database` is a three-value enum** (`ok | slow | unreachable`) on
  `HealthResponseSchema`. `deploy.sh` and the watchdog both key on the STATUS
  CODE, so a `slow` still reads as unhealthy to them — the extra value is for
  whoever reads the body.
- **Pool is `max: 20` (plus the separate 8-connection stats pool, see "Stats reads never share a pool with writes"), and `idle_timeout` is deliberately UNSET.** postgres.js
  defaults `idle_timeout` to null (idle connections are never closed); setting a
  value buys a fresh TCP+TLS handshake after every quiet stretch, which is the
  mis-transplanted node-postgres setting the global notes warn about. 10
  connections were not enough for a service whose hot read is a multi-second
  aggregation over the ledger.
- **The load itself is not fixed here.** `GET /internal/org-usage-total` got the
  denormalized org column (migration 0029); `GET /internal/runs-expected-totals`
  did not, and billing polls it hard — on the whale org it sums ~691k
  platform-projected rows per call. A de-join or a cache for it is its own
  benchmarked PR.

## Stats reads never share a pool with writes (migration 0039)

2026-10-03: social-service's `POST /v1/platform-runs/:id/costs` timed out (15 s)
two days running. ~20 brand-scoped stats reads (5-9 s each, often three identical
copies) held every connection of the one pool, and the cost write queued behind
them. Reproduced from inside the box: 72 concurrent stats reads → a cost POST took
20.1 s.

- **Two pools** (`src/db/index.ts`): `db` (max 20) for writes, lifecycle and
  operational reads (billing totals, `GET /v1/runs`); `statsDb` (max 8,
  `statement_timeout` 30 s) for EVERY read in `routes/stats.ts`, `vendor-costs.ts`,
  `run-outcomes.ts`. A new reporting route imports `statsDb`, never `db`. 8 also
  caps the database CPU stats can take (8 vCPUs shared with the fleet).
- **Identical reads in flight share one execution** (`src/db/coalesce.ts`, on
  `statsDb.execute` only): same SQL + params → the joiner awaits the leader's
  promise. No cache; rows are shared by reference, so readers never mutate them.
- **`idx_runs_org_feature_cover`** `(organization_id, feature_slug) INCLUDE
  (started_at, campaign_id, workflow_slug, brand_ids, audience_id, id)` makes the
  org+brand+feature reads index-only: split read 5-9 s → 1.0 s, audience read
  6.5 s → 2.5 s. Built CONCURRENTLY out-of-band on prod (905 MB).
- **Autovacuum at 2 %** on `runs` / `runs_costs` (default 20 % let `runs` go six
  days with 540k dead rows; the per-day run count fell back to a 7.4 s seq scan).

## A campaign's running runs — `idx_runs_org_service_task_status` (migration 0085, RUNS-LIST-TIMEOUT-1027)

campaign-service's gate check asks `GET /v1/runs?serviceName=campaign-service&taskName=<campaign id>&status=running&limit=200`
before every run. On `idx_runs_org_service` it heap-fetched all 175k campaign-service runs of the owner org: 15-64 s for an
empty answer, 500 past the timeout, campaign 8d3d1ade failed 224 runs in a row (2026-10-22..27). The index keys
(org, service, task, status), all KEY columns (btree dedup keeps it small; disk at 93 %), never partial (the status is a bound
parameter: a generic plan cannot use a `WHERE status = 'running'` index). Built CONCURRENTLY out-of-band on prod.
Guard: `tests/integration/runs-list-running-index.test.ts` (plan names the index, red without it).

## A campaign's runs of one service — `idx_runs_campaign_service_started_cover` (migrations 0087 + 0088, BOX-DB-LOAD-1027-RUNS)

`GET /v1/runs?campaignId|campaignIds&serviceName=…&limit` (campaign-service's gate check with `status`, features-service's
observedPicks per family member) wants the newest runs of one service in a campaign. A campaign's runs are ~1/3 each
campaign-service / workflow / lead-service, so `idx_runs_campaign_started` filtered row by row (3.7 s) and the
campaignId form bitmap-ANDed with the org's 173k service runs then heap-fetched 9.9k matches to keep 51 (2.9 s); ~75 s
of DB time per 5 min (2026-10-27). (campaign_id, service_name, started_at DESC, id DESC) reads the page and stops
(completed: 2.9 s -> 1 ms). 0088 INCLUDEs `status` + `organization_id`: a rare status (`running`, campaign-service gate
check + scheduler) matched almost nothing, so the 0087 walk heap-fetched every campaign-service run of the campaign and
the planner kept the 6 s BitmapAnd; now filtered on the index tuple (index-only, 1.8 s with a lagging visibility map).
Built CONCURRENTLY out-of-band on prod (0087's dropped CONCURRENTLY). Guard: `tests/integration/runs-campaign-service-index.test.ts`
(red without the index or without the INCLUDE; 30k runs, deleted in chunks: one DELETE takes a 0052 advisory lock per run).

## Subtree cost per run, kept at write time (migration 0086, BOX-DB-LOAD-1027-RUNS)

`GET /v1/runs?include=subtreeCost` was this database's heaviest statement: 89k calls / 1,041 min in ~23 h
(2026-10-26/27), ~0.7-1 s each (a 200-run page walked ~1.7k runs, three cold random reads each, box in swap).
Main caller: features-service's Research catalogue (`readWorkflowRuns`, newest 200 execute-workflow runs per org per pipe).

- **`run_subtree_costs`**: per run with an actual/provisioned cost row in its subtree (itself included): n_rows, gross +
  frozen net (`COALESCE(net, gross)`) per status. Cancelled/refunded are in no served figure, so not kept.
- **Triggers**: a cost write adds its delta to its run and every ancestor, upserted ROOT FIRST (two writers in one tree
  meet on the root, so a multi-row statement cannot deadlock a single write); a run delete (BEFORE, still visible) takes
  its still-visible subtree out of its visible ancestors and drops its own row (exact in any row order, 0054's rule); a
  reparent moves the subtree. Same walk as 0054's root_of on every cost write.
- **Read** (`services/run-subtree-cost.ts`): stamp `subtree_cost` and rows in ONE statement (a rebuild cannot un-stamp
  between them); unstamped = the live walk, unchanged. The route formats every figure with `toFixed(10)`, so the body is
  byte-identical either way (guard: `tests/integration/run-subtree-costs-rollup.test.ts`, red if a trigger is off).
- **Readiness**: `scripts/rebuild-stats-rollup.ts subtree_cost` after the deploy (prod: inside the container against `dist/`).
  TRUNCATE in global-setup. Other tree reads (`GET /v1/runs/:id`, batch, `/internal/runs/subtree-costs`) still walk.

## Run creation never queues behind run-tree reads (read pool, 2026-10-17)

2026-10-17 12:31 UTC: onboarding step 1 waited ~48 s because `POST /v1/runs` waited for a
write-pool connection. Twenty `POST /v1/runs/batch` calls (apollo-service acquisition
costs, 500 ids each, 20 s client timeout + retries) held all 20, ~55 s each. task-outcomes
was NOT the cause (statsDb, max 2 in flight).

- **`readDb` (max 10, `statement_timeout` 60 s)** serves `POST /v1/runs/batch`,
  `POST /v1/runs/costs/batch`, `GET /v1/runs/:id`, `GET /v1/runs` (`listRunsPage`,
  `include=subtreeCost`) and the event GETs. `db` keeps writes, lifecycle and billing reads.
  A new read route that walks trees or lists runs imports `readDb`, never `db`.
  Guard: `tests/integration/run-create-isolation.test.ts` (red if the reads share `db`).
- **Every run-tree walk is fenced** (`RUN_TREE_PLAN_NOTE` in `routes/runs.ts`): children
  via `CROSS JOIN LATERAL (… OFFSET 0)`, cost rows via a fenced LATERAL, the walk carries
  its columns. The plain-join forms hashed all of `runs` / seq-scanned all of `runs_costs`
  per call (prod, 500 roots: 6.6 s -> 49 ms, byte-identical).

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
- **`tests/global-setup.ts` runs once per shard and TRUNCATEs all 3 tables.** Kept as a cheap guard for a re-used local database; on CI each shard now gets its own empty container so there is nothing to inherit (it used to matter a lot — CI forked a Neon branch off a parent carrying ~600k production rows, which `/public/stats/*` assertions would otherwise have counted).
- **A NEW integration file must be ADDED to the shard matrix in `.github/workflows/test.yml`, or CI never runs it.** The matrix lists files EXPLICITLY (`matrix.include[].files` → `npx vitest run ${{ matrix.files }}`), it does not glob `tests/integration/`. An unlisted file passes locally, and the PR goes green having never executed it. Default home is the `misc` shard; only a file that reads `/public/*` cross-org needs to think about `stats`.
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
| 6 | Rename silver to `_old` + auto-updatable view shim | ↩️ Merged (#131), then UNDONE (migration 0031) — see below |
| 7 | Drop `_old` tables + view shim | ❌ Unreachable — depended on Phase 4, which was reverted |
| — | Drop dead gold views (`v_run_cost_rollup`, `v_org_platform_spend`, `v_runs_with_descendants`) | ✅ Migration 0026 — unread since `df9230e`; gold is now bounded-CTE-on-read |

### Phases 6-7 undone — silver tables carry their plain names (migration 0031)

`runs` and `runs_costs` are **BASE TABLES** again. There is no `_old` table and no
view shim anywhere in the schema.

Phase 6 renamed the silver base tables to `runs_old` / `runs_costs_old` and put
auto-updatable passthrough views in front of them under the original names. The
suffix was a *sunset signal* for Phase 7: drop the base tables once every read came
off the gold views. Phase 4 was then reverted (`df9230e`) — the gold views OOMed
prod and were dropped outright in migration 0026 — so Phase 7 can never happen and
the suffix had nothing left to signal. It was permanent naming that read as an
unfinished rename. Migration 0031 drops the two shims and renames the base tables
back.

- **No code change, by construction.** The app, the routes' raw SQL, the Drizzle
  models, the tests and both projection-trigger bodies always addressed `runs` /
  `runs_costs` — they were pointed at the shim. Those names now resolve to the base
  table instead of a view. plpgsql resolves `INSERT INTO runs_costs` at execution
  time and PG invalidates plans that referenced the dropped view, so the triggers
  keep projecting across the rename with no function change. Verified end to end
  against a clone of the production schema: bronze inserts before and after the
  migration both project into silver, including `cost.materialized`.
- **Everything attached survives the rename**: the generated predicate columns, all
  30 indexes, and the three foreign keys — none of whose names carried the suffix
  (`runs_costs_run_id_runs_id_fk`, `runs_parent_run_id_runs_id_fk`,
  `run_events_run_id_runs_id_fk`).
- **Boot-window safe.** `DROP VIEW` + `ALTER TABLE … RENAME` are catalog-only: a
  brief ACCESS EXCLUSIVE lock, no heap rewrite, O(1) on a multi-million-row ledger.
- **Historical migrations still say `_old`** (0021-0030 were written while the shim
  was live). That is immutable history, not live naming; `tests/integration/indexes.test.ts`
  pins the live schema — `runs` / `runs_costs` are BASE TABLEs and no `%_old`
  relation exists.

#### Adding or renaming a silver column now

The shim is gone, so the two-step dance it forced is gone with it: `ALTER TABLE runs
ADD COLUMN …` / `ALTER TABLE runs RENAME COLUMN x TO y` is the whole change. Still
update any projection-trigger function body that references the column + its payload
key, with a `COALESCE(NEW.payload->>'newKey', NEW.payload->>'oldKey')` fallback so
pre-rename bronze events still replay (reference: migration 0025).

## Retention — leaf telemetry only (migration 0032)

`run_events` is purged at **30 days** by this service, in
`src/services/run-events-retention.ts`. It was the largest relation in the database
(4.9 GB / 2.56M rows after 6.0M expired rows were deleted by hand from outside the
repo) and re-accumulates ~2.6M rows a month.

- **Only the LEAF telemetry log is purgeable.** `run_events` projects to nothing and
  nothing is derived from it. The bronze LIFECYCLE logs (`run_lifecycle_events`,
  `cost_lifecycle_events`) are the source silver is projected FROM — purging them
  would destroy the ability to rebuild `runs` / `runs_costs`, which is the whole
  point of the bronze layer. They are never swept, at any age. A test asserts a
  400-day-old lifecycle row survives a sweep.
- **Sweep shape**: chunked `DELETE … WHERE id IN (SELECT id … ORDER BY created_at
  LIMIT 5000)`, capped at 400 chunks per sweep so a long-unpurged table cannot run
  unbounded; the remainder is picked up next sweep. Runs every 6h, started AFTER
  `app.listen()` (never in front of the port bind), errors logged loudly and retried
  on the next tick rather than crashing the process.
- **`idx_run_events_created_at` is what makes it cheap.** The three pre-existing
  indexes are all prefixed by another column, so none can range-scan `created_at`;
  without it every chunk seq-scans 4.9 GB. Built out-of-band `CONCURRENTLY` on
  prod/staging (the migration ships `IF NOT EXISTS` non-concurrent → no-ops there),
  same discipline as 0027 / 0029 / 0030.

## CI runs against an empty Postgres container

Integration shards start a `postgres:17` service container (matching the production
server version) and apply `drizzle-kit migrate` to it. Each shard gets its own
database, so shards are isolated and nothing is inherited.

This replaced a Neon-branch-per-shard setup, which stopped working when the Neon
project was deleted in the self-hosted cutover — every shard failed at
`Failed to create branch … 404 project not found`, repo-wide, from 2026-08-01.

**The migration chain is now exercised from ZERO on every PR, and it did not build
an empty database.** The Neon branches were forked from a production-shaped parent,
so migrations were only ever applied INCREMENTALLY and a broken chain looked green:
migration 0005 had been edited after the fact to add `cost_source` under its
post-rename name, so 0007's `RENAME COLUMN cost_bearer TO cost_source` aborted on a
fresh database. 0007 is now guarded on the old column existing. A from-zero build
was diffed against the production schema (all columns with types/nullability/
generated-ness, plus every index) and is identical.

Editing a historical migration file is safe: `drizzle-orm`'s migrator skips by the
journal's `created_at` timestamp, not by a content hash, so an already-migrated
database never re-runs an edited file.

## CI status checks ↔ branch protection

Branch protection on `staging` requires status checks named exactly `test-integration` and `test-unit`. The `test-integration` matrix job produces context names like `test-integration (stats, …)` which do NOT match the required name. A separate aggregator job named `test-integration` (depends on `test-integration-shard`, fails if any shard failed) provides the required context. When changing the matrix structure, keep the aggregator job name intact or PRs will sit in `BLOCKED` despite green shards.
