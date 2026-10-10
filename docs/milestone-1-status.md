# Implementation and verification ledger

Updated: 10 October 2026

## Implemented in source

- [x] Starter repository inspected and preserved.
- [x] SQL migration for organizations, departments, users, memberships, sessions, budgets, purchase requests, reservations, audit events, and idempotency records.
- [x] Migration runner and local seed script.
- [x] Express health, origin policy, request IDs, structured logging, error responses.
- [x] Password hashing with Node scrypt and opaque hashed session tokens.
- [x] Session expiry/revocation and CSRF token flow.
- [x] Department/organization-scoped budgets and purchase requests.
- [x] Transactional approval, reservation, rejection, and cancellation paths.
- [x] Idempotency helper storing mutation response atomically with business state.
- [x] Request/budget/audit/dashboard APIs.
- [x] React interface for login, overview, request management, budget management, and activity.
- [x] Unit tests defined for exact money parsing/formatting, password hashing/verification, request fingerprinting, and the HTTP liveness/404 boundary.
- [x] In this environment, isolated exact-money, password, and request-fingerprint unit tests were transpiled to a temporary ESM tree and executed: 4 passed, 0 failed. This is not the full npm test suite.
- [x] Gated PostgreSQL integration test for competing approvals, idempotent replay, cross-tenant denial, cancellation/release replay, rejection without reservation, and self-approval denial (test source present; database execution is still pending).
- [x] Isolated concurrency experiment harness with unsafe baselines and raw JSONL/Markdown output.
- [x] API, architecture, security, database, research, testing, and evaluation documentation.
- [x] Concurrency harness synchronizes every request in each unlocked wave after its initial read, avoiding a conditional-barrier deadlock in the comparison workload.
- [x] CSS stylesheet expanded from compressed one-line rules into readable rule/declaration formatting.

## Checks performed in this environment

- [x] ZIP archive listing and starter-file inspection.
- [x] JSON parse check for package/TypeScript manifests.
- [x] TypeScript/TSX syntax transpilation with the globally available TypeScript transpiler (26 source/test files, 0 syntax diagnostics; syntax check only, not a typecheck).
- [x] JSON parsing for root/workspace package manifests and TypeScript configs.
- [x] YAML parsing for Docker Compose, GitHub Actions, Dependabot, and OpenAPI files.
- [x] Confirmed environment limitations: Docker/PostgreSQL CLI unavailable; npm installation timed out. `git diff --check` passed. The concurrency experiment barrier was corrected so each unlocked request wave rendezvous after reading its initial balance.

## Not yet verified

- [ ] `npm install` and lockfile generation (the attempt timed out; no `package-lock.json` exists).
- [ ] TypeScript type checking against real dependency types.
- [ ] Production builds for API and frontend.
- [ ] Full `npm test` suite (the full suite needs the unavailable workspace dependencies; only four dependency-free unit tests were executed from transpiled source).
- [ ] PostgreSQL migration application and seed command.
- [ ] API integration test against a disposable PostgreSQL `_test` database.
- [ ] Full browser workflow testing.
- [ ] Actual final concurrency experiment and data review.
- [ ] GitHub Actions execution and successful CI result.
- [ ] Public deployment, TLS, backup/restore, or operational monitoring.

## Current blocker

Network/package registry access is not completing in the authoring environment, and Docker/PostgreSQL are unavailable. Source-level work is present, and four isolated exact-money/password/fingerprint tests passed from transpiled source, but the complete running application cannot be honestly reported as validated until the dependency-backed typecheck/build and PostgreSQL/browser checks run in a Node/npm/PostgreSQL-capable environment.
