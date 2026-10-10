# Database design

The initial schema is `db/migrations/001_initial_schema.sql`. The API uses `pg` and explicit SQL.

## Entities

- `organizations`: tenant and fixed currency.
- `departments`: organization-owned departments.
- `users`: global identity, password hash, active flag.
- `memberships`: a user's role and department inside one organization.
- `sessions`: hash of an opaque session token, CSRF token, expiry, revocation.
- `budgets`: one monthly budget per department with limit/reserved minor units.
- `purchase_requests`: request details and state.
- `reservations`: one reservation per request, active or released.
- `audit_events`: append-only through ordinary app operations.
- `idempotency_records`: scoped key, payload fingerprint, and committed response.
- `schema_migrations`: applied migration filenames.

## Exact amounts

Amounts are integer minor units in PostgreSQL `BIGINT`. API monetary amounts are decimal strings, and `parseMinorUnits` converts validated decimal input directly to `bigint`. JavaScript floating point is not used for business calculations.

## Tenant integrity

Foreign keys include organization IDs where needed so a request cannot refer to a budget from a different tenant. All read and write queries still apply server-side authorization; composite foreign keys are defense in depth, not a replacement for access checks.

## Transaction contract

All SQL in one transaction uses the same checked-out `PoolClient`. Approval locks the request row first and then the budget row, rechecks state/permissions/budget under lock, creates the reservation, updates the request and budget, inserts audit history, saves the idempotency response, and commits. Cancellation uses the same request-then-budget lock order.

The invariant checker compares budget `reserved_minor` against the sum of active reservations. A budget-level `CHECK` prevents reserved from exceeding the limit even if an application bug attempts an invalid update.
