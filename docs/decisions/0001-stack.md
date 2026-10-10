# ADR-0001: Initial stack

- **Status:** accepted for Milestone 1, pending installation compatibility check.
- **Date:** 2026-10-10.

## Decision

- Node.js 24 LTS for the intended development runtime.
- TypeScript 6.0.x with strict compiler options.
- Express 5.x for a small REST monolith.
- PostgreSQL 18.x for relational integrity, row locks, and transactions.
- `pg` for explicit parameterized SQL and transparent transaction boundaries.
- Zod for runtime environment/input validation.
- Pino for structured logging.
- React 19 with Vite for a small client-side workflow UI.
- Docker Compose for repeatable local PostgreSQL when Docker is available.

## Why

The project should demonstrate SQL and backend fundamentals rather than hide them behind an ORM. React/Vite is sufficient for the required interaction; server rendering is not required. Express is simpler than introducing NestJS-specific concepts at this stage.

## Trade-offs

Explicit SQL requires care with mapping and type handling. `pg` does not provide application models or migrations by itself; a migration tool will be chosen in Milestone 2. The browser UI and API have separate type-checking contexts. Docker must be installed locally to use Compose.

## Compatibility caveat

The package versions listed in package manifests are exact direct-dependency selections based on current documentation and project planning. This environment could not reach the npm registry during Milestone 1, so no lockfile was generated and the full dependency tree has not been installed or tested. Before treating the dependency set as verified, perform a clean install, inspect peer-dependency output, run typecheck/build/tests, and commit the generated lockfile.
