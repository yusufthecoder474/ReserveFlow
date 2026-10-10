# ReserveFlow API

Base path: `/api`. All JSON responses use UTF-8. Authenticated browser calls use the `rf_session` HttpOnly cookie. Mutating authenticated calls require `X-CSRF-Token`. State-transition mutations require `Idempotency-Key`.

## Session

- `POST /auth/login` — `{ "email": "...", "password": "...", "organizationSlug"?: "..." }`. Returns `{ authenticated, csrfToken }` and sets a session cookie.
- `GET /auth/me` — returns user, organization, role, and CSRF token.
- `POST /auth/logout` — revokes the current session and clears the cookie.

## Dashboard and reference data

- `GET /dashboard/summary`
- `GET /departments`
- `GET /budgets?period=YYYY-MM`
- `GET /budgets/:id`
- `POST /budgets` (finance admin): `{ departmentId, periodKey, limitAmount }`
- `PATCH /budgets/:id` (finance admin): `{ limitAmount }`

`limitAmount` is a decimal string with at most two fractional digits. A budget cannot be lowered below its reserved amount.

## Purchase requests

- `GET /requests?status=&q=&limit=&offset=`
- `POST /requests`: `{ budgetId, title, description, amount }`
- `GET /requests/:id`
- `PATCH /requests/:id` — update an owned draft's `title`, `description`, and/or `amount`.
- `POST /requests/:id/submit` — requires `Idempotency-Key`.
- `POST /requests/:id/approve` — approver only, requires `Idempotency-Key`.
- `POST /requests/:id/reject` — approver only, `{ reason }`, requires `Idempotency-Key`.
- `POST /requests/:id/cancel` — request owner or finance admin, requires `Idempotency-Key`.
- `GET /requests/:id/audit`
- `GET /audit?limit=100` — finance admin only.

## Errors

Errors follow `{ "error": { "code", "message", "requestId", "details"? } }`. The API uses 400 for invalid inputs, 401 for missing/expired sessions, 403 for denied actions, 404 for missing/inaccessible records, 409 for state/idempotency/budget conflicts, 413 for oversized JSON, 429 for login throttling, and 503 for unavailable dependencies.

This document describes the intended implemented contract; verify the running OpenAPI spec and source after installation before relying on it in integrations.
