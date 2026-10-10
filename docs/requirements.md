# ReserveFlow product requirements

## Purpose

ReserveFlow is a standalone portfolio application for business budget and purchase approval workflows. It demonstrates TypeScript/Node.js, Express REST APIs, PostgreSQL data modeling, React, authorization, transactional correctness, and testable reliability behavior.

## User roles

- **Employee:** create and edit their draft requests, submit them, inspect own requests/history, and cancel eligible requests.
- **Approver:** inspect their department's requests and approve or reject submitted requests; cannot approve or reject their own request.
- **Finance admin:** manage budgets and inspect requests/audit records in their organization.

## Main workflow

1. Finance creates a monthly budget for a department.
2. Employee creates a draft request using a budget in the same department and organization.
3. Employee submits the request.
4. Department approver approves or rejects it.
5. Approval reserves funds transactionally; it is not a payment.
6. Cancellation of an approved request releases the reservation transactionally.
7. Authorized users inspect the request history.
8. Repeating a supported transition with the same idempotency key and payload replays the original result rather than repeating the effect.

## Invariants

- `0 <= reserved_minor <= limit_minor`.
- Budget reserved amount matches active reservation totals.
- One reservation row per purchase request.
- Reservation and request must use the same budget and organization.
- A requester cannot approve their own request.
- A committed state transition has a corresponding audit record.
- Idempotent replay does not duplicate a reservation, release, transition, or audit event.
- Users cannot access records outside the organization and role/department scope.
- Money is represented as integer minor units in PostgreSQL `BIGINT`; decimal inputs are parsed to `bigint` without floating-point calculations.

## Out of scope

Real payments, card data, bank connections, multi-currency conversion, tax calculation, receipt uploads, SSO, email, approval-policy builders, and financial regulatory certification.

## Success criteria

- API and UI complete the main local workflow against PostgreSQL.
- The isolated competing-approval scenario does not overcommit budget.
- Idempotency replay returns the original stored result.
- Integration tests demonstrate tenant isolation and the reservation invariant.
- Setup instructions work from a clean checkout after dependencies/database are available.
