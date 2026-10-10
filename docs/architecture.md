# ReserveFlow architecture

## Runtime shape

```text
React + Vite (development on loopback)
            │ same-origin /api proxy
            ▼
Express + TypeScript modular monolith
  ├─ request IDs, logs, origin and JSON boundary
  ├─ session authentication and CSRF validation
  ├─ role / tenant authorization
  ├─ budget and purchase-request workflows
  ├─ transaction and idempotency service
  └─ SQL repository queries
            │ one checked-out pg client per transaction
            ▼
PostgreSQL
```

There is one application and one PostgreSQL database. No payment service, task queue, distributed cache, LLM, or accounting provider is used.

## Backend modules

- `src/app.ts`: middleware, origin policy, health routes, route registration, and error handling.
- `src/routes/auth.ts`: login, current session, logout, and in-memory login throttling.
- `src/routes/business.ts`: budget, request, dashboard, and audit APIs.
- `src/lib/auth.ts`: opaque sessions, token hashing, actor resolution, roles, CSRF checks, and cookie helpers.
- `src/lib/password.ts`: scrypt password hash creation and verification.
- `src/lib/idempotency.ts`: transaction-wrapped scoped idempotency key handling.
- `src/lib/http.ts`: structured API errors and exact decimal-to-minor-unit conversion.
- `src/db.ts`: ordered, tracked SQL migrations.
- `src/seed.ts`: local-only demo users and sample organization/budget data.

## Approval transaction

The approver's request and the relevant budget row are locked in a consistent order. Authorization, submitted state, self-approval restrictions, and available amount are rechecked after the request lock. A reservation, budget update, state transition, audit event, and idempotency response commit in one transaction. The database's `reserved_minor <= limit_minor` CHECK is a final invariant guard. The budget row lock serializes approvals sharing that budget.

All statements within a transaction use the same `PoolClient`. Errors trigger rollback before being returned to the client. Cancellation locks the request then budget, marks its active reservation as released, decrements the budget, changes status, records the event, and stores the response atomically.

## Idempotency

Keys are scoped to organization, actor, operation name, and key string. The JSON payload is fingerprinted. The first operation stores its response in the same transaction as business changes. A duplicate key waits for any competing insert to commit, then either replays the same response or returns a conflict when the fingerprint differs. If a transaction fails before commit, the idempotency record is rolled back with it.

## Authorization

The session identifies a user and organization membership. Finance admins see authorized data in their organization; approvers can see requests for their department; employees can see requests they submitted. Every object route includes the organization boundary in SQL and then enforces role/ownership rules. Composite tenant-aware foreign keys reinforce these checks.

## Frontend

The React application uses a small same-origin API client with credentials, CSRF headers, error decoding, and stable operation keys for mutations. Views cover login, dashboard, requests, creation, budgets, history, and request details. Client controls improve usability but never replace server validation or authorization.

## Known limitations

- Login rate limiting is in-memory and per API process; it is a portfolio baseline, not a multi-replica deployment strategy.
- The demo uses one membership/role per user per organization.
- CSRF uses an opaque session-held token and an allowlisted origin.
- Deployment, HTTPS, reverse-proxy trust, backups, restore, and monitoring must be configured and verified separately.
- `pg` schema DDL and integration behavior must be tested on the targeted PostgreSQL version. The authoring environment did not have Docker or a working npm installation, so runtime verification remains outstanding.
