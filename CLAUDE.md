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

## Mandatory: Tests for Every Change

Every bug fix, new feature, or behavioral change **must** include corresponding tests. No exceptions.

### Rules

1. **Bug fixes** → Add a regression test that reproduces the bug before the fix, and passes after.
2. **New endpoints/routes** → Add integration tests in `tests/integration/` using supertest.
3. **New utility functions / business logic** → Add unit tests in `tests/unit/`.
4. **Schema changes** → Update integration tests to cover new columns/tables.

### Test file conventions

- Unit tests: `tests/unit/<module-name>.test.ts`
- Integration tests: `tests/integration/<resource>.test.ts`
- Test framework: Vitest + supertest
- Run before committing: `npm run test:unit` (unit) and `npm run test:integration` (integration)

### CI

Tests run on every push to `main` and every PR via `.github/workflows/test.yml`. Both `test:unit` and `test:integration` jobs must pass.

### Checklist before completing any task

- [ ] Tests written covering the change
- [ ] `npm run test:unit` passes locally
- [ ] No existing tests broken

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
