import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

const enabled = process.env.RESERVEFLOW_RUN_DB_TESTS === '1';

test('PostgreSQL-backed purchase workflow preserves budget invariants under competing approvals', { skip: !enabled }, async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests.');
  const databaseName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
  if (!/(?:_test|_experiment)$/.test(databaseName)) throw new Error('Refusing integration tests unless DATABASE_URL points to a database ending in _test or _experiment.');

  const [{ createApp }, { pool }, { migrate }] = await Promise.all([
    import('./app.js'), import('./database.js'), import('./db.js')
  ]);
  await migrate();
  const organization = await pool.query<{ id: string }>("SELECT id FROM organizations WHERE slug = 'northstar-demo'");
  if (!organization.rows[0]) throw new Error('Seed the test database first with npm run db:seed.');
  const organizationId = organization.rows[0].id;

  const resetClient = await pool.connect();
  try {
    await resetClient.query('BEGIN');
    await resetClient.query('DELETE FROM idempotency_records WHERE organization_id = $1', [organizationId]);
    await resetClient.query('DELETE FROM audit_events WHERE organization_id = $1', [organizationId]);
    await resetClient.query('DELETE FROM reservations WHERE organization_id = $1', [organizationId]);
    await resetClient.query('DELETE FROM purchase_requests WHERE organization_id = $1', [organizationId]);
    await resetClient.query("UPDATE budgets SET reserved_minor = 0, limit_minor = 100000, updated_at = now() WHERE organization_id = $1", [organizationId]);
    await resetClient.query('COMMIT');
  } catch (error) {
    await resetClient.query('ROLLBACK');
    throw error;
  } finally { resetClient.release(); }

  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  async function login(email: string) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: process.env.RESERVEFLOW_SEED_PASSWORD })
    });
    assert.equal(response.status, 200, `Login failed for ${email}`);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const payload = await response.json() as { csrfToken: string };
    return { cookie, csrf: payload.csrfToken };
  }

  async function jsonRequest<T>(cookie: string, csrf: string, path: string, method = 'GET', body?: unknown, idempotencyKey?: string) {
    const headers: Record<string, string> = { Cookie: cookie, Accept: 'application/json' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = csrf; }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = response.status === 204 ? undefined : await response.json();
    return { response, payload: payload as T };
  }

  try {
    const employee = await login('employee@reserveflow.local');
    const approver = await login('approver@reserveflow.local');
    const finance = await login('finance@reserveflow.local');
    const budgetResult = await jsonRequest<{ budgets: Array<{ id: string; limitMinor: string }> }>(employee.cookie, employee.csrf, '/api/budgets');
    assert.equal(budgetResult.response.status, 200);
    const budget = budgetResult.payload.budgets[0];
    assert.ok(budget, 'Seed a budget before running integration tests.');
    const budgetId = budget.id;
    assert.equal(budget.limitMinor, '100000');

    async function createAndSubmit(title: string) {
      const created = await jsonRequest<{ request: { id: string } }>(employee.cookie, employee.csrf, '/api/requests', 'POST', { budgetId, title, description: 'Created by a disposable integration test.', amount: '700.00' });
      assert.equal(created.response.status, 201);
      const id = created.payload.request.id;
      const submitted = await jsonRequest(employee.cookie, employee.csrf, `/api/requests/${id}/submit`, 'POST', {}, `submit-${idempotencySuffix(id)}`);
      assert.equal(submitted.response.status, 200);
      return id;
    }

    const [firstId, secondId] = await Promise.all([createAndSubmit('Competing request A'), createAndSubmit('Competing request B')]);
    const approvals = await Promise.all([firstId, secondId].map((id) => jsonRequest(approver.cookie, approver.csrf, `/api/requests/${id}/approve`, 'POST', {}, `approve-${idempotencySuffix(id)}`)));
    assert.equal(approvals.filter((item) => item.response.status === 200).length, 1, 'Exactly one competing approval should succeed.');
    assert.equal(approvals.filter((item) => item.response.status === 409).length, 1, 'The over-budget approval should conflict.');

    const persisted = await pool.query<{ limit_minor: string; reserved_minor: string; active_sum: string; approved_count: string }>(`
      SELECT b.limit_minor::text, b.reserved_minor::text,
             COALESCE((SELECT SUM(amount_minor) FROM reservations WHERE budget_id = b.id AND status = 'active'), 0)::text AS active_sum,
             (SELECT COUNT(*) FROM purchase_requests WHERE budget_id = b.id AND status = 'approved')::text AS approved_count
      FROM budgets b WHERE b.id = $1
    `, [budgetId]);
    assert.equal(persisted.rows[0]?.reserved_minor, '70000');
    assert.equal(persisted.rows[0]?.active_sum, '70000');
    assert.equal(persisted.rows[0]?.approved_count, '1');
    assert.ok(BigInt(persisted.rows[0]!.reserved_minor) <= BigInt(persisted.rows[0]!.limit_minor));

    const otherTenant = await login('employee@otherco.local');
    const successfulId = approvals.find((item) => item.response.status === 200) === approvals[0] ? firstId : secondId;
    const crossTenant = await jsonRequest(otherTenant.cookie, otherTenant.csrf, `/api/requests/${successfulId}`);
    assert.equal(crossTenant.response.status, 404);

    const replay = await jsonRequest(approver.cookie, approver.csrf, `/api/requests/${successfulId}/approve`, 'POST', {}, `approve-${idempotencySuffix(successfulId)}`);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.response.headers.get('idempotency-replayed'), 'true');
    const active = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM reservations WHERE request_id = $1 AND status = 'active'", [successfulId]);
    assert.equal(active.rows[0]?.count, '1');

    const cancelKey = `cancel-${idempotencySuffix(successfulId)}`;
    const cancelled = await jsonRequest<{ request: { status: string } }>(employee.cookie, employee.csrf, `/api/requests/${successfulId}/cancel`, 'POST', {}, cancelKey);
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.payload.request.status, 'cancelled');
    const cancelReplay = await jsonRequest<{ request: { status: string } }>(employee.cookie, employee.csrf, `/api/requests/${successfulId}/cancel`, 'POST', {}, cancelKey);
    assert.equal(cancelReplay.response.status, 200);
    assert.equal(cancelReplay.payload.request.status, 'cancelled');
    assert.equal(cancelReplay.response.headers.get('idempotency-replayed'), 'true');
    const afterCancel = await pool.query<{ reserved_minor: string; active_count: string }>(`
      SELECT b.reserved_minor::text,
             (SELECT COUNT(*)::text FROM reservations WHERE request_id = $2 AND status = 'active') AS active_count
      FROM budgets b WHERE b.id = $1
    `, [budgetId, successfulId]);
    assert.equal(afterCancel.rows[0]?.reserved_minor, '0');
    assert.equal(afterCancel.rows[0]?.active_count, '0');

    const rejectedDraft = await jsonRequest<{ request: { id: string } }>(employee.cookie, employee.csrf, '/api/requests', 'POST', {
      budgetId, title: 'Rejected purchase request', description: 'Must not reserve budget.', amount: '25.00'
    });
    assert.equal(rejectedDraft.response.status, 201);
    const rejectedId = rejectedDraft.payload.request.id;
    const rejectedSubmit = await jsonRequest( employee.cookie, employee.csrf, `/api/requests/${rejectedId}/submit`, 'POST', {}, `submit-${idempotencySuffix(rejectedId)}`);
    assert.equal(rejectedSubmit.response.status, 200);
    const rejection = await jsonRequest<{ request: { status: string; rejectionReason: string } }>(approver.cookie, approver.csrf, `/api/requests/${rejectedId}/reject`, 'POST', { reason: 'The request does not include a required justification.' }, `reject-${idempotencySuffix(rejectedId)}`);
    assert.equal(rejection.response.status, 200);
    assert.equal(rejection.payload.request.status, 'rejected');
    assert.equal(rejection.payload.request.rejectionReason, 'The request does not include a required justification.');

    const approverDraft = await jsonRequest<{ request: { id: string } }>(approver.cookie, approver.csrf, '/api/requests', 'POST', {
      budgetId, title: 'Approver self-approval test', description: 'Must not be approved by its requester.', amount: '10.00'
    });
    assert.equal(approverDraft.response.status, 201);
    const ownRequestId = approverDraft.payload.request.id;
    const ownSubmit = await jsonRequest(approver.cookie, approver.csrf, `/api/requests/${ownRequestId}/submit`, 'POST', {}, `submit-${idempotencySuffix(ownRequestId)}`);
    assert.equal(ownSubmit.response.status, 200);
    const selfApproval = await jsonRequest<{ error: { code: string } }>(approver.cookie, approver.csrf, `/api/requests/${ownRequestId}/approve`, 'POST', {}, `approve-${idempotencySuffix(ownRequestId)}`);
    assert.equal(selfApproval.response.status, 403);
    assert.equal(selfApproval.payload.error.code, 'SELF_APPROVAL_FORBIDDEN');

    const finalReservation = await pool.query<{ reserved_minor: string; active_sum: string }>(`
      SELECT b.reserved_minor::text,
             COALESCE((SELECT SUM(amount_minor) FROM reservations WHERE budget_id = b.id AND status = 'active'), 0)::text AS active_sum
      FROM budgets b WHERE b.id = $1
    `, [budgetId]);
    assert.equal(finalReservation.rows[0]?.reserved_minor, '0');
    assert.equal(finalReservation.rows[0]?.active_sum, '0');

    // Confirm the finance administrator can view organization-level data.
    const financeMe = await jsonRequest<{ user: { role: string } }>(finance.cookie, finance.csrf, '/api/auth/me');
    assert.equal(financeMe.payload.user.role, 'finance_admin');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  }
});

function idempotencySuffix(value: string) { return value.replaceAll('-', '').slice(0, 20).padEnd(8, '0'); }
