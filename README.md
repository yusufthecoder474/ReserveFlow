# ReserveFlow

ReserveFlow is a standalone, research-informed full-stack application for budget-aware purchase requests and approvals. It is designed to demonstrate Node.js/TypeScript, Express, PostgreSQL, REST APIs, React, application security, testing, and correctness under concurrent requests.

**Scope:** synthetic business workflow only. No real payments, corporate cards, bank connections, accounting credentials, or confidential company data are used. Approval reserves budget; it does not mean payment happened. This is a student portfolio project, not a certified fintech service.

## Feature status

The repository now contains an implementation of the MVP workflow: local seeded sessions; organization memberships and role-scoped access; department budgets; purchase-request draft, submission, approval, rejection, and cancellation; PostgreSQL reservation transactions; audit events; idempotency records for state transitions; a React interface; SQL migrations; unit tests; a gated PostgreSQL integration test; and a disposable-schema concurrency experiment.

**Verification caveat:** this authoring environment did not have Docker and `npm install` timed out. The source was syntax-transpiled (23 TypeScript/TSX files, zero syntax diagnostics), JSON manifests were parsed, and archive structure was checked. Three isolated exact-money/password tests passed from a temporary transpiled copy. The full dependency-backed typecheck/build/test suite and PostgreSQL/browser workflows could not be completed here. See [milestone status](docs/milestone-1-status.md) and [testing guide](docs/testing.md). Do not describe unexecuted checks as passing.

## Stack

- Node.js 24 LTS recommended (repository declares Node >=22.12.0).
- TypeScript, Express 5, `pg`, Zod, Pino.
- PostgreSQL with explicit SQL migrations and transaction boundaries.
- React + Vite.
- Node test runner via `tsx`, PostgreSQL integration tests, and a concurrency harness.
- Docker Compose, npm workspaces, GitHub Actions.

The direct dependency versions are pinned in the workspace package manifests. Verify registry availability and advisories during installation and commit the resulting lockfile before using the app beyond local development.

## Prerequisites

- Node.js compatible with Vite 8 and the project engine declaration.
- npm.
- Docker and Docker Compose for local PostgreSQL, or a disposable PostgreSQL database you manage.

## First-time local setup

```bash
cp .env.example .env
npm install
# Start PostgreSQL on loopback with the local-only credentials from .env.example.
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev:api
```

In a second terminal:

```bash
npm run dev:web
```

Open the Vite URL printed by the command, typically `http://127.0.0.1:5173`.

The seed command refuses `NODE_ENV=production`. It uses `RESERVEFLOW_SEED_PASSWORD` from your local `.env`. These are demo accounts; never reuse the local password in a deployment. Accounts:

- `employee@reserveflow.local`
- `approver@reserveflow.local`
- `finance@reserveflow.local`
- `employee@otherco.local` (separate tenant, no seeded budget)

## Common commands

```bash
npm run dev:api
npm run dev:web
npm run db:migrate
npm run db:seed
npm run typecheck
npm run build
npm test
```

The PostgreSQL-backed integration test resets request/audit/reservation/idempotency data in the seeded demo organization. It must only be used against a disposable database whose name ends in `_test` or `_experiment`:

```bash
# In .env, set DATABASE_URL to a disposable database such as reserveflow_test.
npm run db:migrate
npm run db:seed
RESERVEFLOW_RUN_DB_TESTS=1 npm run test:integration
```

## Concurrency evaluation

Configure `RESERVEFLOW_EXPERIMENT_DATABASE_URL` to a disposable PostgreSQL database named with suffix `_test` or `_experiment`. The harness creates a random temporary schema, runs isolated safe and unsafe variants, writes raw JSONL results and a Markdown report under `experiments/results/`, then drops only its temporary schema.

```bash
npm run experiment:concurrency
RESERVEFLOW_EXPERIMENT_MODE=final npm run experiment:concurrency
```

Pilot mode uses 5 trials per configuration. Final mode uses 30 trials per configuration. The unsafe baselines intentionally omit the budget-limit CHECK constraint in their isolated experiment schema to make application-level race behavior observable. They are never reachable through the ReserveFlow API. Do not run experiments against a database containing important data.

## Design details

- [Architecture](docs/architecture.md)
- [Database model](docs/database.md)
- [Requirements](docs/requirements.md)
- [API contract](docs/api.md)
- [OpenAPI description](docs/openapi.yaml)
- [Threat model](docs/threat-model.md)
- [Research notes](docs/research.md)
- [Evaluation methodology](docs/research-methodology.md)
- [Testing](docs/testing.md)
- [Dependency verification](docs/dependency-verification.md)

## Security notes

Sessions use opaque random tokens stored as SHA-256 hashes, CSRF tokens, secure cookie options, origin allowlisting, server-side tenant authorization, parameterized SQL, request validation, and password hashing with scrypt. Confirm settings behind a reverse proxy before deployment. The demo seed password and local database credentials are not deployment secrets. Audit rows are append-only through normal application routes but are not tamper-proof against a privileged database administrator.

Do not claim PCI DSS compliance, regulatory approval, security certification, production scale, uptime, or absence of vulnerabilities. Use appropriate independent security review before any real-world use.
