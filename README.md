# Runs Service

REST API for tracking service execution runs and their associated costs. Supports hierarchical runs (parent-child), cost aggregation, and multi-tenant isolation via organizations.

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

### Organizations

#### Create or retrieve an organization

```
POST /v1/organizations
```

Upserts by `externalId` — returns the existing organization if it already exists.

**Request body**
```json
{ "externalId": "org_clerk_123" }
```

**Response** `201` (created) or `200` (already exists)
```json
{
  "id": "uuid",
  "externalId": "org_clerk_123",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

---

### Users

#### Create or retrieve a user

```
POST /v1/users
```

Upserts by `externalId`. The organization must exist.

**Request body**
```json
{
  "externalId": "user_clerk_456",
  "organizationId": "uuid"
}
```

**Response** `201` (created) or `200` (already exists)
```json
{
  "id": "uuid",
  "externalId": "user_clerk_456",
  "organizationId": "uuid",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z"
}
```

**Errors**
| Status | Meaning |
|--------|---------|
| `404` | Organization not found |

---

### Runs

#### Create a run

```
POST /v1/runs
```

**Request body**
```json
{
  "organizationId": "uuid",
  "serviceName": "my-agent",
  "taskName": "generate-report",
  "userId": "uuid",
  "parentRunId": "uuid"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `organizationId` | yes | Organization owning this run |
| `serviceName` | yes | Name of the calling service |
| `taskName` | yes | Name of the task being executed |
| `userId` | no | User who triggered the run |
| `parentRunId` | no | Parent run ID for hierarchical tracking |

**Response** `201`
```json
{
  "id": "uuid",
  "organizationId": "uuid",
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
GET /v1/runs?organizationId=uuid
```

**Query parameters**
| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `organizationId` | yes | — | Filter by organization |
| `serviceName` | no | — | Filter by service name |
| `userId` | no | — | Filter by user |
| `status` | no | — | `running`, `completed`, or `failed` |
| `startedAfter` | no | — | ISO 8601 timestamp |
| `startedBefore` | no | — | ISO 8601 timestamp |
| `limit` | no | `50` | Max `200` |
| `offset` | no | `0` | Pagination offset |

**Response** `200`
```json
{
  "runs": [ ... ],
  "limit": 50,
  "offset": 0
}
```

---

#### Get a run (with costs)

```
GET /v1/runs/:id
```

Returns the run with its cost breakdown, including recursively aggregated children costs.

**Response** `200`
```json
{
  "id": "uuid",
  "organizationId": "uuid",
  "serviceName": "my-agent",
  "taskName": "generate-report",
  "status": "completed",
  "startedAt": "2025-01-01T00:00:00.000Z",
  "completedAt": "2025-01-01T00:01:00.000Z",
  "costs": [
    {
      "id": "uuid",
      "costName": "gpt-4o-input-tokens",
      "quantity": "1500.000000",
      "unitCostInUsdCents": "0.0002500000",
      "totalCostInUsdCents": "0.3750000000"
    }
  ],
  "ownCostInUsdCents": "0.3750000000",
  "childrenCostInUsdCents": "0.1200000000",
  "totalCostInUsdCents": "0.4950000000"
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

Adds cost line items. Unit costs are resolved automatically from the [costs-service](https://github.com/shamanic-technologies/costs-service).

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

#### Get cost summary

```
GET /v1/runs/summary?organizationId=uuid
```

Aggregates costs across runs with optional grouping.

**Query parameters**
| Param | Required | Description |
|-------|----------|-------------|
| `organizationId` | yes | Filter by organization |
| `serviceName` | no | Filter by service name |
| `startedAfter` | no | ISO 8601 timestamp |
| `startedBefore` | no | ISO 8601 timestamp |
| `groupBy` | no | `serviceName`, `userId`, or `costName` |

**Response** `200`
```json
{
  "breakdown": [
    {
      "key": "my-agent",
      "totalCostInUsdCents": "12.5000000000",
      "runCount": 5
    }
  ]
}
```

---

## Quick Start (calling the API)

```bash
# 1. Register your organization
ORG=$(curl -s -X POST https://your-url/v1/organizations \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"externalId": "my-org"}')

ORG_ID=$(echo $ORG | jq -r '.id')

# 2. Start a run
RUN=$(curl -s -X POST https://your-url/v1/runs \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"organizationId\": \"$ORG_ID\", \"serviceName\": \"my-agent\", \"taskName\": \"chat\"}")

RUN_ID=$(echo $RUN | jq -r '.id')

# 3. Record costs
curl -s -X POST https://your-url/v1/runs/$RUN_ID/costs \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"items": [{"costName": "gpt-4o-input-tokens", "quantity": 2000}]}'

# 4. Complete the run
curl -s -X PATCH https://your-url/v1/runs/$RUN_ID \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "completed"}'
```

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
