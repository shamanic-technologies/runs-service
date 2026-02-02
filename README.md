# Runs Service

API service for tracking computational runs and their associated costs. Part of the [Shamanic Technologies](https://github.com/shamanic-technologies) platform.

## Stack

- **Runtime**: Node.js 20 / TypeScript
- **Framework**: Express
- **Database**: PostgreSQL with [Drizzle ORM](https://orm.drizzle.team/)
- **Hosting**: Railway (Docker)
- **Tests**: Vitest + Supertest

## Setup

```bash
npm install
cp .env.example .env   # then fill in real values
npm run db:push         # push schema to database
npm run dev             # start with hot reload
```

### Environment variables

| Variable | Description |
|---|---|
| `RUNS_SERVICE_DATABASE_URL` | PostgreSQL connection string |
| `RUNS_SERVICE_API_KEY` | API key for authenticating requests |
| `COSTS_SERVICE_URL` | URL of the costs service (default: `https://costs.mcpfactory.org`) |
| `COSTS_SERVICE_API_KEY` | API key for the costs service |
| `PORT` | Server port |

## Authentication

All endpoints (except `/health`) require an `X-API-Key` header matching `RUNS_SERVICE_API_KEY`.

## API endpoints

### Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check (no auth) |

### Organizations

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/organizations` | Upsert organization by `externalId` |

### Users

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/users` | Upsert user by `externalId` + `organizationId` |

### Runs

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/runs` | Create a run (`organizationId`, `serviceName`, `taskName` required) |
| `GET` | `/v1/runs` | List runs (filter by `organizationId` (required), `serviceName`, `taskName`, `userId`, `status`, `startedAfter`, `startedBefore`, `limit`, `offset`) |
| `GET` | `/v1/runs/:id` | Get run with costs (includes recursive children cost aggregation) |
| `PATCH` | `/v1/runs/:id` | Update run status (`completed` or `failed`) |
| `POST` | `/v1/runs/:id/costs` | Add cost line items (resolves unit costs from costs-service) |
| `GET` | `/v1/runs/summary` | Aggregate costs (group by `serviceName`, `userId`, or `costName`) |

## Database schema

Four tables: `organizations`, `users`, `runs`, `runs_costs`.

- Runs support parent-child hierarchies (`parentRunId`)
- Cost aggregation is recursive via CTEs
- Costs cascade-delete when a run is deleted

## Scripts

```bash
npm run dev              # development with hot reload
npm run build            # compile TypeScript
npm run start            # production server
npm test                 # run all tests
npm run test:unit        # unit tests only
npm run test:integration # integration tests (needs DB)
npm run db:generate      # generate Drizzle migrations
npm run db:migrate       # apply migrations
npm run db:push          # push schema directly
npm run db:studio        # open Drizzle Studio
```

## Deployment

Deployed on Railway via Docker. See `Dockerfile` and `railway.json` for config.
