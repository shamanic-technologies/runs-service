# Runs Service

REST API for tracking service execution runs and their associated costs. Supports hierarchical runs (parent-child), cost aggregation with full descendant tree, and multi-tenant isolation via Clerk organization IDs.

## Base URL

```
https://your-deployment-url
```

## Authentication

All endpoints (except `/health`) require an API key via the `X-API-Key` header.

```bash
curl -H "X-API-Key: your-secret-api-key" https://your-deployment-url/v1/runs
```

## OpenAPI Specification

The service exposes its OpenAPI 3.0 spec at `/openapi.json` (no authentication required). The spec is generated from Zod schemas in `src/schemas.ts` using `@asteasolutions/zod-to-openapi`, ensuring documentation stays in sync with runtime validation.

```bash
curl https://your-deployment-url/openapi.json
```

To regenerate the spec locally:

```bash
npm run generate:openapi
```

The spec is also regenerated automatically on every `npm run build`.

---

## API Reference

### Health Check

```
GET /health
```

No authentication required. Verifies database connectivity.

**Response** `200` (healthy)
```json
{ "status": "ok", "service": "runs-service", "database": "ok" }
```

**Response** `503` (degraded — database unreachable)
```json
{ "status": "degraded", "service": "runs-service", "database": "unreachable" }
```

---

### Runs

#### Create a run

```
POST /v1/runs
```

Organizations and users are resolved automatically from `clerkOrgId`/`clerkUserId` (get-or-create).

**Request body**
```json
{
  "clerkOrgId": "org_clerk_123",
  "clerkUserId": "user_clerk_456",
  "appId": "my-app",
  "brandId": "brand_1",
  "campaignId": "campaign_1",
  "serviceName": "my-agent",
  "taskName": "generate-report",
  "parentRunId": "uuid"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `clerkOrgId` | yes | Clerk organization ID (auto-resolved internally) |
| `appId` | yes | Application identifier |
| `serviceName` | yes | Name of the calling service |
| `taskName` | yes | Name of the task being executed |
| `clerkUserId` | no | Clerk user ID (auto-resolved internally) |
| `brandId` | no | Brand identifier |
| `campaignId` | no | Campaign identifier |
| `parentRunId` | no | Parent run ID for hierarchical tracking |

**Response** `201`
```json
{
  "id": "uuid",
  "organizationId": "uuid",
  "userId": "uuid",
  "appId": "my-app",
  "brandId": "brand_1",
  "campaignId": "campaign_1",
  "serviceName": "my-agent",
  "taskName": "generate-report",
  "status": "running",
  "startedAt": "2025-01-01T00:00:00.000Z",
  "completedAt": null,
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

---

#### List runs

```
GET /v1/runs?clerkOrgId=org_clerk_123
```

Each run in the response includes `ownCostInUsdCents`.

**Query parameters**
| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `clerkOrgId` | yes | — | Filter by Clerk organization ID |
| `clerkUserId` | no | — | Filter by Clerk user ID |
| `appId` | no | — | Filter by application ID |
| `brandId` | no | — | Filter by brand ID |
| `campaignId` | no | — | Filter by campaign ID |
| `serviceName` | no | — | Filter by service name |
| `taskName` | no | — | Filter by task name |
| `status` | no | — | `running`, `completed`, or `failed` |
| `parentRunId` | no | — | Filter by parent run ID |
| `startedAfter` | no | — | ISO 8601 timestamp |
| `startedBefore` | no | — | ISO 8601 timestamp |
| `limit` | no | `50` | Max `200` |
| `offset` | no | `0` | Pagination offset |

**Response** `200`
```json
{
  "runs": [
    {
      "id": "uuid",
      "appId": "my-app",
      "serviceName": "my-agent",
      "taskName": "chat",
      "status": "completed",
      "ownCostInUsdCents": "0.3750000000",
      "..."
    }
  ],
  "limit": 50,
  "offset": 0
}
```

---

#### Get a run (with costs and descendants)

```
GET /v1/runs/:id
```

Returns the run with its cost breakdown, including all descendant runs and their costs in a flat `descendantRuns` array. Each descendant includes its `parentRunId` so the tree can be reconstructed client-side.

**Response** `200`
```json
{
  "id": "uuid",
  "organizationId": "uuid",
  "appId": "my-app",
  "serviceName": "lead-service",
  "taskName": "enrich-lead",
  "status": "completed",
  "costs": [
    {
      "id": "uuid",
      "costName": "anthropic-opus-4.5-tokens-input",
      "quantity": "3867.000000",
      "unitCostInUsdCents": "0.0050000000",
      "totalCostInUsdCents": "0.0193000000"
    }
  ],
  "ownCostInUsdCents": "0.0212000000",
  "childrenCostInUsdCents": "0.3400000000",
  "totalCostInUsdCents": "0.3612000000",
  "descendantRuns": [
    {
      "id": "uuid",
      "parentRunId": "uuid",
      "serviceName": "apollo-service",
      "taskName": "search-people",
      "status": "completed",
      "costs": [
        {
          "id": "uuid",
          "costName": "apollo-enrichment-credit",
          "quantity": "1.000000",
          "unitCostInUsdCents": "0.3400000000",
          "totalCostInUsdCents": "0.3400000000"
        }
      ],
      "ownCostInUsdCents": "0.3400000000"
    }
  ]
}
```

**Errors**
| Status | Meaning |
|--------|---------|
| `404` | Run not found |

---

#### Add costs to a run

```
POST /v1/runs/:id/costs
```

Adds cost line items. Unit costs are resolved automatically from the [costs-service](https://github.com/shamanic-technologies/costs-service). Requests to the costs-service are retried up to 3 times with exponential backoff (1s, 2s, 4s) on transient errors (502, 503, 429) and network failures.

**Request body**
```json
{
  "items": [
    { "costName": "gpt-4o-input-tokens", "quantity": 1500 },
    { "costName": "gpt-4o-output-tokens", "quantity": 300 }
  ]
}
```

**Response** `201`
```json
{
  "costs": [
    {
      "id": "uuid",
      "runId": "uuid",
      "costName": "gpt-4o-input-tokens",
      "quantity": "1500.000000",
      "unitCostInUsdCents": "0.0002500000",
      "totalCostInUsdCents": "0.3750000000",
      "createdAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

**Errors**
| Status | Meaning |
|--------|---------|
| `404` | Run not found |
| `422` | Unknown cost name (not found in costs-service) |
| `502` | Costs-service unavailable after retries |

---

#### Update run status

```
PATCH /v1/runs/:id
```

**Request body**
```json
{ "status": "completed" }
```

Allowed values: `completed`, `failed`. Sets `completedAt` automatically.

**Response** `200` — updated run object.

**Errors**
| Status | Meaning |
|--------|---------|
| `400` | Invalid status value |
| `404` | Run not found |

---

## Quick Start (calling the API)

```bash
# 1. Start a run (org is auto-created from clerkOrgId)
RUN=$(curl -s -X POST https://your-url/v1/runs \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"clerkOrgId": "org_clerk_123", "appId": "my-app", "serviceName": "my-agent", "taskName": "chat"}')

RUN_ID=$(echo $RUN | jq -r '.id')

# 2. Record costs
curl -s -X POST https://your-url/v1/runs/$RUN_ID/costs \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"items": [{"costName": "gpt-4o-input-tokens", "quantity": 2000}]}'

# 3. Complete the run
curl -s -X PATCH https://your-url/v1/runs/$RUN_ID \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'

# 4. Get full cost tree
curl -s https://your-url/v1/runs/$RUN_ID \
  -H "X-API-Key: $API_KEY" | jq .
```

---

## Database Schema

### organizations (internal, auto-managed)
| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `externalId` | text | Clerk organization ID (unique) |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

### users (internal, auto-managed)
| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `externalId` | text | Clerk user ID (unique) |
| `organizationId` | uuid | FK to organizations |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

### runs
| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `parentRunId` | uuid | Self-referencing FK (nullable) |
| `organizationId` | uuid | FK to organizations |
| `userId` | uuid | FK to users (nullable) |
| `appId` | text | Application identifier (NOT NULL) |
| `brandId` | text | Brand identifier (nullable) |
| `campaignId` | text | Campaign identifier (nullable) |
| `serviceName` | text | Service that created the run |
| `taskName` | text | Task being executed |
| `status` | text | `running`, `completed`, `failed` |
| `startedAt` | timestamp | |
| `completedAt` | timestamp | Nullable |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

### runs_costs
| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `runId` | uuid | FK to runs (cascade delete) |
| `costName` | text | Cost type identifier |
| `quantity` | numeric(20,6) | |
| `unitCostInUsdCents` | numeric(12,10) | |
| `totalCostInUsdCents` | numeric(16,10) | |
| `createdAt` | timestamp | |

---

## Self-Hosting

### Prerequisites

- Node.js 20+
- PostgreSQL database

### Setup

```bash
git clone https://github.com/shamanic-technologies/runs-service.git
cd runs-service
npm install
cp .env.example .env  # edit with your values
npm run db:push        # push schema to database
npm run dev            # start with hot reload
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RUNS_SERVICE_DATABASE_URL` | yes | PostgreSQL connection string |
| `RUNS_SERVICE_API_KEY` | yes | API key for authenticating requests |
| `COSTS_SERVICE_URL` | no | Costs service URL (default: `https://costs.mcpfactory.org`) |
| `COSTS_SERVICE_API_KEY` | no | API key for the costs service |
| `PORT` | no | Server port |

### Scripts

```bash
npm run dev              # development with hot reload
npm run build            # compile TypeScript + generate OpenAPI spec
npm run generate:openapi # regenerate OpenAPI spec only
npm run start            # production server
npm test                 # run all tests
npm run test:unit        # unit tests only
npm run test:integration # integration tests (needs DB)
npm run db:generate      # generate Drizzle migrations
npm run db:migrate       # apply migrations
npm run db:push          # push schema directly
npm run db:studio        # open Drizzle Studio
```

### Docker

```bash
docker build -t runs-service .
docker run -e RUNS_SERVICE_DATABASE_URL=... -e RUNS_SERVICE_API_KEY=... -p 3000:3000 runs-service
```

---

## Tech Stack

- **Runtime:** Node.js 20 + TypeScript (strict)
- **Framework:** Express
- **Validation:** Zod + @asteasolutions/zod-to-openapi
- **Database:** PostgreSQL + Drizzle ORM
- **Hosting:** Railway (Docker)
- **Tests:** Vitest + Supertest
