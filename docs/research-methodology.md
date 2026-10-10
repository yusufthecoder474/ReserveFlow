# ReserveFlow evaluation methodology

## Research question

Under a declared synthetic workload, does row-locked transactional budget reservation prevent overcommitment and reservation inconsistency during competing approvals, and how does it affect local request latency?

## Experimental variants

1. **Unsafe read-check-write:** experimental-only schema without a budget-limit CHECK constraint; each operation reads the available balance, synchronizes at a test barrier, then increments the reserved total.
2. **Transaction without budget-row serialization:** a transaction begins, reads the balance without `FOR UPDATE`, waits at the same test barrier, then performs the write.
3. **Transaction with budget-row serialization:** each operation locks the shared budget row with `SELECT ... FOR UPDATE`, checks the latest balance, and commits a reservation only when sufficient funds remain.

Variants 1 and 2 are intentional defect demonstrations. They live only in `experiments/` and must never be exposed by the web application or connected to an application database. The experiment refuses to run unless its dedicated database name ends in `_test` or `_experiment`.

## Workload

- Budget limit: 100,000 minor units.
- Each attempted reservation: 70,000 minor units.
- Operations per trial: 32 in pilot mode, 100 in final mode.
- Concurrency levels: 1, 2, 8, and 16.
- Trials: 5 in pilot mode, 30 in final mode.
- Every trial resets the isolated schema's budget and reservation rows.
- The unsafe variants use a barrier after the read to make the check/write race reproducible.

## Outputs

The harness writes a JSONL line per trial, including variant, concurrency, operations, accepted/rejected/failing counts, reserved amount, reservation sum, overcommitment, mismatch, and latency median/p95/max. It also generates a Markdown summary.

## Acceptance criteria

- The locked variant must not reserve more than the limit.
- Its budget reserved total must match the active reservation sum.
- The unsafe baselines must be evaluated honestly; if a race is not observed, report it instead of inventing a result.
- A separate integration test validates the actual application against a disposable PostgreSQL database, including competing approvals, duplicate idempotency replay, and cross-tenant denial.

## Variables and validity

Record database version, Node version, OS, host/container configuration, commit, dependency lockfile, and mode. This is a local synthetic experiment. The barrier intentionally magnifies one race and does not estimate the natural frequency of races in production. The unprotected schema deliberately removes the budget check constraint to expose application-level defects; it is not the app's schema. Measurements are not production performance claims.

## Execution

Set `RESERVEFLOW_EXPERIMENT_DATABASE_URL` to a disposable PostgreSQL database named with suffix `_test` or `_experiment`. Then run:

```bash
npm run experiment:concurrency
RESERVEFLOW_EXPERIMENT_MODE=final npm run experiment:concurrency
```

The default is pilot mode. No results should be included in a resume until an actual run finishes and the raw JSONL is reviewed.
