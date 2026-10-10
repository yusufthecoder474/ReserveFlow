# ReserveFlow threat model

## Scope and trust boundaries

Assets: credentials, session tokens, organization/department data, budgets, purchase requests, reservation state, idempotency keys, and audit history. Trust boundaries are the browser/API boundary, actor/tenant authorization, API/PostgreSQL boundary, and local build/dependency pipeline.

## Threats and mitigations

| Threat | Mitigation | Verification planned or included |
|---|---|---|
| Cross-tenant record reads or mutations | Session-scoped organization predicates; role/ownership checks; tenant-aware foreign keys | Gated PostgreSQL integration test checks another tenant receives 404 for a request; expand matrix for list, count, dashboard, and audit endpoints |
| Broken object-level authorization | Resolve actor from session; check role, ownership, and department on each object action | API scenarios for owners, approvers, finance, other department, and other tenant |
| Self-approval | Approval handler rejects requester acting as approver | Integration/business-rule test should assert no change to request, reservation, or audit state |
| SQL injection | Parameterized queries; route input validation; explicit field allowlists | Negative input and boundary tests |
| Session theft or replay | Random opaque session token; store only SHA-256 token hash; HttpOnly cookie; expiry and revocation | Login/logout/session tests; production requires HTTPS and `SESSION_COOKIE_SECURE=true` |
| CSRF | HttpOnly SameSite=Lax cookie, allowlisted Origin, CSRF token header for authenticated mutations | Origin/CSRF negative API tests are still to be expanded |
| Password guessing | scrypt password hashes, generic credential errors, simple per-process login throttling | Login verification and rate-limit tests; distributed rate limiting is not implemented |
| Mass assignment | Strict Zod schemas and explicit SQL assignments | Tests should send protected fields such as role, organization ID, status, approver, or budget totals |
| Budget race condition | Request/budget row locks, recheck under lock, transaction, budget CHECK constraint | Gated concurrent approval integration test and disposable-schema evaluation harness |
| Duplicate mutation / lost response | Scoped idempotency key, payload fingerprint, stored response, same transaction as business effects | Gated integration test replays an approval key and confirms one active reservation; add more injected-failure cases |
| Inconsistent audit/reservation state | State change, reservation and audit record share one transaction; rollback on error | Independently query committed DB state after operations |
| Log data exposure | Pino redaction; no request bodies, passwords, cookies, or SQL parameters are intentionally logged | Review fields emitted by tests and production deployment configuration |
| JSON resource abuse | 64 KB JSON body cap, bounded pagination, schema limits | Parser and oversized-body tests |
| Dependency compromise | Pinned direct dependencies, lockfile to be generated, CI dependency scan planned | Dependency install/advisory verification remains outstanding |
| Unsafe CI permissions or secret leakage | Minimal workflow permissions, action SHA pinning, no deployment secrets in PR workflows | Review `.github/workflows/ci.yml` before enabling external deployments |

## Residual risks

- In-memory login rate limiting resets on restart and is not shared across replicas.
- A privileged database administrator can modify audit records; normal application routes expose no audit update/delete function, but this is not tamper-proof storage.
- A passing finite suite cannot prove the absence of all authorization or concurrency bugs.
- The project is not certified, audited for regulatory compliance, or approved for real financial use.
- Deployment controls such as TLS, proxy headers, backups, monitoring, secret rotation, and operational access controls must be independently configured and reviewed.
