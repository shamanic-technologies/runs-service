# Runs Service - Agent Rules

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
