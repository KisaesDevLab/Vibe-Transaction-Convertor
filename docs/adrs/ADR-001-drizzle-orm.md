# ADR-001 — Drizzle ORM (not Prisma)

## Status

Accepted.

## Context

The persistence layer needs typed queries against PostgreSQL 16, project-co-located
migrations, and a footprint small enough to ship in a distroless Docker image. Two
tools dominate the TypeScript landscape: Prisma and Drizzle. Prisma has a large
runtime engine, owns its own migration tooling, and produces a generated client
that is awkward to compose with raw SQL. The Vibe family already ships Drizzle in
`vibe-mybooks` and `vibe-tb`, so an operator who has run those products already
understands the migration mental model.

## Decision

Use **Drizzle ORM** for all database access. Schema lives at
`apps/api/src/db/schema.ts`. Generated and hand-written migrations live at
`apps/api/src/db/migrations/`, checked into source control. The Drizzle config
file at `apps/api/drizzle.config.ts` points at the schema and writes the
`vibetc` Postgres schema. Migrations are applied programmatically via a runner
at `apps/api/src/db/migrate.ts` so the API container can self-migrate on boot
(or, in operator-controlled environments, refuse to start if migrations are
unapplied).

## Consequences

- **Pro:** SQL-first, no generated client, trivial to drop into raw SQL when a
  query is too gnarly for the query builder.
- **Pro:** Lightweight runtime — no separate engine binary to ship.
- **Pro:** Migrations are visible plain SQL, easy to review.
- **Con:** Less hand-holding than Prisma; we must enforce best practices via
  ESLint (`eslint-plugin-drizzle`) — see ADR-013 and Phase 2.
- **Con:** Drizzle's TypeScript inference is heavier than Prisma's; large
  schemas can slow `tsc`. Mitigation: keep `apps/api/src/db/types.ts` thin and
  re-export inferred row types only where needed.

## References

- `apps/api/src/db/schema.ts`
- `apps/api/drizzle.config.ts`
- BuildPlan.md §3 ADR-001, Phase 3.
