# Runs Service — Claude Instructions

## README maintenance (mandatory)

**Every PR that changes functionality must include a README.md update.** This is the most important rule in this file.

When you modify any of the following, update `README.md` to reflect the change:

- **API endpoints** — new routes, changed request/response shapes, removed endpoints. Update the "API endpoints" section tables.
- **Database schema** — new tables, new columns, changed relationships. Update the "Database schema" section.
- **Environment variables** — new env vars, renamed vars, removed vars. Update the "Environment variables" table.
- **Dependencies** — major new dependencies that change the stack description. Update the "Stack" section if relevant.
- **Scripts** — new or changed npm scripts. Update the "Scripts" section.
- **Authentication** — changes to auth middleware or auth flow. Update the "Authentication" section.
- **Deployment** — changes to Dockerfile, railway.json, or deployment flow. Update the "Deployment" section.
- **Setup steps** — if the setup process changes, update the "Setup" section.

If your change doesn't affect any of the above categories, no README update is needed.

## Tech stack

- TypeScript strict mode, ESM (`"type": "module"`)
- Express 4 on Node 20
- PostgreSQL with Drizzle ORM
- Vitest for testing
- Deployed on Railway via Docker

## Conventions

- Functional patterns over classes
- Keep solutions simple, no over-engineering
- All routes go in `src/routes/`
- DB schema in `src/db/schema.ts`
- Middleware in `src/middleware/`
- Services/integrations in `src/services/`
