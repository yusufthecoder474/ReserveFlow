# Testing guide

## Unit tests

```bash
npm test
```

Unit tests cover exact monetary parsing/formatting, password hashing and verification, deterministic request fingerprints, and the HTTP health/404 boundary. These do not replace a PostgreSQL-backed integration test.

## Local PostgreSQL integration

Use a dedicated database name ending in `_test`; never point the reset-capable integration test at a personal or production database.

```bash
cp .env.example .env
# Change DATABASE_URL to a dedicated PostgreSQL database such as reserveflow_test.
npm install
npm run db:migrate
npm run db:seed
RESERVEFLOW_RUN_DB_TESTS=1 npm run test:integration
```

The test resets request, reservation, audit, and idempotency rows in the seeded demo organization. It creates two AED 700 requests against an AED 1,000 budget and checks that exactly one competing approval succeeds, the reservation total is 700, duplicate replay creates no extra reservation, and an employee from another tenant receives 404 for the request.

## Build and type checking

```bash
npm run typecheck
npm run build
npm test
```

## Limitations

Tests only support claims for the exercised scenarios. A passing test suite is not a guarantee that no defect or security vulnerability exists. Record test output and commit identity when collecting project evidence.
