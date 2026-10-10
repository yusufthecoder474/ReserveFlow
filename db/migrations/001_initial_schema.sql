BEGIN;

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  currency_code char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, currency_code)
);

CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name),
  UNIQUE (id, organization_id)
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  full_name text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 120),
  password_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, email)
);

CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  department_id uuid,
  role text NOT NULL CHECK (role IN ('employee', 'approver', 'finance_admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  UNIQUE (user_id, organization_id),
  FOREIGN KEY (department_id, organization_id)
    REFERENCES departments(id, organization_id) ON DELETE RESTRICT,
  CHECK ((role = 'finance_admin' AND department_id IS NULL) OR (role <> 'finance_admin' AND department_id IS NOT NULL)),
  UNIQUE (id, organization_id)
);

CREATE INDEX IF NOT EXISTS memberships_department_idx ON memberships (organization_id, department_id, role);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_token char(64) NOT NULL CHECK (csrf_token ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, organization_id) REFERENCES memberships(user_id, organization_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sessions_user_org_idx ON sessions (user_id, organization_id, expires_at);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  department_id uuid NOT NULL,
  period_key char(7) NOT NULL CHECK (period_key ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  limit_minor bigint NOT NULL CHECK (limit_minor > 0),
  reserved_minor bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0 AND reserved_minor <= limit_minor),
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (department_id, organization_id) REFERENCES departments(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id, organization_id) REFERENCES memberships(user_id, organization_id) ON DELETE RESTRICT,
  UNIQUE (department_id, period_key),
  UNIQUE (id, department_id, organization_id),
  UNIQUE (id, organization_id)
);

CREATE INDEX IF NOT EXISTS budgets_org_period_idx ON budgets (organization_id, period_key, department_id);

CREATE TABLE IF NOT EXISTS purchase_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  department_id uuid NOT NULL,
  budget_id uuid NOT NULL,
  requester_user_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled')),
  submitted_at timestamptz,
  decided_at timestamptz,
  rejection_reason text CHECK (rejection_reason IS NULL OR length(rejection_reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (department_id, organization_id) REFERENCES departments(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (budget_id, department_id, organization_id) REFERENCES budgets(id, department_id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (requester_user_id, organization_id) REFERENCES memberships(user_id, organization_id) ON DELETE RESTRICT,
  UNIQUE (id, organization_id),
  UNIQUE (id, budget_id, organization_id),
  CHECK (
    (status = 'draft' AND submitted_at IS NULL AND decided_at IS NULL) OR
    (status = 'submitted' AND submitted_at IS NOT NULL AND decided_at IS NULL) OR
    (status IN ('approved', 'rejected') AND submitted_at IS NOT NULL AND decided_at IS NOT NULL) OR
    status = 'cancelled'
  ),
  CHECK ((status = 'rejected' AND rejection_reason IS NOT NULL) OR (status <> 'rejected' AND rejection_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS requests_org_status_created_idx ON purchase_requests (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_dept_status_idx ON purchase_requests (organization_id, department_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_requester_idx ON purchase_requests (organization_id, requester_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  budget_id uuid NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  FOREIGN KEY (budget_id, organization_id) REFERENCES budgets(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (request_id, budget_id, organization_id) REFERENCES purchase_requests(id, budget_id, organization_id) ON DELETE RESTRICT,
  CHECK ((status = 'active' AND released_at IS NULL) OR (status = 'released' AND released_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS reservations_budget_status_idx ON reservations (budget_id, status);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  request_id uuid,
  actor_user_id uuid NOT NULL,
  operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 2 AND 80),
  from_status text,
  to_status text,
  reason text CHECK (reason IS NULL OR length(reason) <= 1000),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (request_id, organization_id) REFERENCES purchase_requests(id, organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, organization_id) REFERENCES memberships(user_id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS audit_request_timeline_idx ON audit_events (organization_id, request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_org_timeline_idx ON audit_events (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  operation_name text NOT NULL CHECK (length(operation_name) BETWEEN 2 AND 100),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  response_status integer NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  response_body jsonb NOT NULL CHECK (jsonb_typeof(response_body) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (actor_user_id, organization_id) REFERENCES memberships(user_id, organization_id) ON DELETE RESTRICT,
  UNIQUE (organization_id, actor_user_id, operation_name, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idempotency_created_idx ON idempotency_records (created_at);

-- Normal application credentials can read audit events but never update or delete them.
-- This is not tamper-proof against a privileged database administrator.

COMMIT;
