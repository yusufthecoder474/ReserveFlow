import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { pool } from '../database.js';
import { apiError, parseMinorUnits } from '../lib/http.js';
import { actorFrom, requireAuth, requireCsrf, requireRole, type Actor } from '../lib/auth.js';
import { HttpFault, runIdempotentMutation, type MutationResult } from '../lib/idempotency.js';

export const businessRouter = Router();
businessRouter.use(requireAuth);

const idSchema = z.string().uuid();
const periodSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const moneySchema = z.string().trim().regex(/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/);
const requestBodySchema = z.object({
  budgetId: idSchema,
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().max(2000).default(''),
  amount: moneySchema
}).strict();
const updateDraftSchema = z.object({
  title: z.string().trim().min(3).max(140).optional(),
  description: z.string().trim().max(2000).optional(),
  amount: moneySchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required.');
const createBudgetSchema = z.object({
  departmentId: idSchema,
  periodKey: periodSchema,
  limitAmount: moneySchema
}).strict();
const patchBudgetSchema = z.object({ limitAmount: moneySchema }).strict();
const rejectSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
const emptySchema = z.object({}).strict();

function invalid(res: import('express').Response, issues: unknown) {
  apiError(res, 400, 'VALIDATION_ERROR', 'Check the supplied fields and try again.', issues);
}
function routeId(value: unknown): string {
  // Express 5 route-param typings may expose string | string[]. Treat route
  // parameters as untrusted input and accept only one string UUID.
  if (typeof value !== 'string' || !idSchema.safeParse(value).success) {
    throw new HttpFault(400, 'INVALID_ID', 'The identifier is invalid.');
  }
  return value;
}
function canSeeRequest(row: { organization_id: string; department_id: string; requester_user_id: string; status?: string }, actor: Actor) {
  if (row.organization_id !== actor.organizationId) return false;
  if (actor.role === 'finance_admin') return true;
  if (actor.role === 'approver') return row.department_id === actor.departmentId && (row.status !== 'draft' || row.requester_user_id === actor.userId);
  return row.requester_user_id === actor.userId;
}
function assertActorCanSeeRequest(row: { organization_id: string; department_id: string; requester_user_id: string; status?: string }, actor: Actor) {
  if (!canSeeRequest(row, actor)) throw new HttpFault(404, 'REQUEST_NOT_FOUND', 'The requested record was not found.');
}

// Idempotency replay bypasses the mutation callback, so always revalidate current
// object-level permissions before returning a previously stored response.
async function preflightRequestAccess(actor: Actor, requestId: string, action: 'submit' | 'approve' | 'reject' | 'cancel') {
  const result = await pool.query<{ organization_id: string; department_id: string; requester_user_id: string; status: string }>(
    'SELECT organization_id, department_id, requester_user_id, status FROM purchase_requests WHERE id = $1 AND organization_id = $2',
    [requestId, actor.organizationId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpFault(404, 'REQUEST_NOT_FOUND', 'The requested record was not found.');
  assertActorCanSeeRequest(row, actor);
  if (action === 'submit' && row.requester_user_id !== actor.userId) {
    throw new HttpFault(403, 'REQUEST_OWNER_REQUIRED', 'Only the requester can submit this request.');
  }
  if (action === 'submit' && row.department_id !== actor.departmentId) {
    throw new HttpFault(404, 'REQUEST_NOT_FOUND', 'The requested record was not found.');
  }
  if ((action === 'approve' || action === 'reject') && row.department_id !== actor.departmentId) {
    throw new HttpFault(404, 'REQUEST_NOT_FOUND', 'The requested record was not found.');
  }
  if ((action === 'approve' || action === 'reject') && row.requester_user_id === actor.userId) {
    throw new HttpFault(403, 'SELF_APPROVAL_FORBIDDEN', 'You cannot approve or reject your own request.');
  }
  if (action === 'cancel' && actor.role !== 'finance_admin' && row.requester_user_id !== actor.userId) {
    throw new HttpFault(403, 'REQUEST_OWNER_REQUIRED', 'Only the requester or finance administrator can cancel this request.');
  }
}

async function addAudit(client: PoolClient, input: {
  organizationId: string; requestId?: string | null; actorUserId: string; operationId?: string;
  eventType: string; fromStatus?: string | null; toStatus?: string | null; reason?: string | null;
  details?: Record<string, unknown>;
}) {
  await client.query(`
    INSERT INTO audit_events (organization_id, request_id, actor_user_id, operation_id, event_type, from_status, to_status, reason, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
  `, [input.organizationId, input.requestId ?? null, input.actorUserId, input.operationId ?? randomUUID(), input.eventType,
    input.fromStatus ?? null, input.toStatus ?? null, input.reason ?? null, JSON.stringify(input.details ?? {})]);
}

async function getRequestDetails(client: Pool | PoolClient, requestId: string, organizationId: string) {
  const result = await client.query<Record<string, unknown> & QueryResultRow>(`
    SELECT r.id, r.organization_id AS "organizationId", r.department_id AS "departmentId", r.budget_id AS "budgetId",
           r.requester_user_id AS "requesterUserId", u.full_name AS "requesterName", u.email AS "requesterEmail",
           d.name AS "departmentName", b.period_key AS "periodKey", r.title, r.description,
           r.amount_minor::text AS "amountMinor", r.status, r.submitted_at AS "submittedAt", r.decided_at AS "decidedAt",
           r.rejection_reason AS "rejectionReason", r.created_at AS "createdAt", r.updated_at AS "updatedAt",
           o.currency_code AS "currencyCode", b.limit_minor::text AS "budgetLimitMinor", b.reserved_minor::text AS "budgetReservedMinor",
           (b.limit_minor - b.reserved_minor)::text AS "budgetAvailableMinor"
    FROM purchase_requests r
    JOIN users u ON u.id = r.requester_user_id
    JOIN departments d ON d.id = r.department_id AND d.organization_id = r.organization_id
    JOIN budgets b ON b.id = r.budget_id AND b.organization_id = r.organization_id
    JOIN organizations o ON o.id = r.organization_id
    WHERE r.id = $1 AND r.organization_id = $2
  `, [requestId, organizationId]);
  return result.rows[0] ?? null;
}

async function getBudgetDetails(client: Pool | PoolClient, budgetId: string, organizationId: string) {
  const result = await client.query<Record<string, unknown> & QueryResultRow>(`
    SELECT b.id, b.organization_id AS "organizationId", b.department_id AS "departmentId", d.name AS "departmentName",
           b.period_key AS "periodKey", b.limit_minor::text AS "limitMinor", b.reserved_minor::text AS "reservedMinor",
           (b.limit_minor - b.reserved_minor)::text AS "availableMinor", o.currency_code AS "currencyCode",
           b.created_at AS "createdAt", b.updated_at AS "updatedAt"
    FROM budgets b JOIN departments d ON d.id = b.department_id AND d.organization_id = b.organization_id
    JOIN organizations o ON o.id = b.organization_id
    WHERE b.id = $1 AND b.organization_id = $2
  `, [budgetId, organizationId]);
  return result.rows[0] ?? null;
}

function requireBudgetDepartment(actor: Actor, departmentId: string) {
  if (actor.role !== 'finance_admin' && actor.departmentId !== departmentId) {
    throw new HttpFault(404, 'BUDGET_NOT_FOUND', 'The requested budget was not found.');
  }
}

businessRouter.get('/dashboard/summary', async (_req, res) => {
  const actor = actorFrom(res);
  const params: unknown[] = [actor.organizationId];
  let deptClause = '';
  let requestClause = '';
  if (actor.role !== 'finance_admin') {
    params.push(actor.departmentId);
    deptClause = ' AND department_id = $2';
  }
  if (actor.role === 'employee') {
    params.push(actor.userId);
    requestClause = ' AND requester_user_id = $2';
  } else if (actor.role === 'approver') {
    requestClause = " AND department_id = $2 AND (status <> 'draft' OR requester_user_id = $3)";
  }
  const budgets = await pool.query<{ limit_minor: string; reserved_minor: string }>(
    `SELECT COALESCE(SUM(limit_minor), 0)::text AS limit_minor, COALESCE(SUM(reserved_minor), 0)::text AS reserved_minor FROM budgets WHERE organization_id = $1${deptClause}`,
    params.slice(0, actor.role === 'finance_admin' ? 1 : 2));
  const requestParams: unknown[] = [actor.organizationId];
  if (actor.role === 'employee') requestParams.push(actor.userId);
  else if (actor.role === 'approver') requestParams.push(actor.departmentId, actor.userId);
  const requests = await pool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count FROM purchase_requests WHERE organization_id = $1${requestClause} GROUP BY status`, requestParams);
  const counts = Object.fromEntries(requests.rows.map((row) => [row.status, Number(row.count)]));
  const limitMinor = BigInt(budgets.rows[0]?.limit_minor ?? '0');
  const reservedMinor = BigInt(budgets.rows[0]?.reserved_minor ?? '0');
  res.json({
    currencyCode: actor.currencyCode,
    limitMinor: limitMinor.toString(), reservedMinor: reservedMinor.toString(), availableMinor: (limitMinor - reservedMinor).toString(),
    requestCounts: { draft: counts.draft ?? 0, submitted: counts.submitted ?? 0, approved: counts.approved ?? 0, rejected: counts.rejected ?? 0, cancelled: counts.cancelled ?? 0 },
    awaitingApproval: counts.submitted ?? 0
  });
});

businessRouter.get('/departments', async (_req, res) => {
  const actor = actorFrom(res);
  const result = await pool.query(`
    SELECT d.id, d.name FROM departments d WHERE d.organization_id = $1
      AND ($2::text = 'finance_admin' OR d.id = $3) ORDER BY d.name
  `, [actor.organizationId, actor.role, actor.departmentId]);
  res.json({ departments: result.rows });
});

businessRouter.get('/budgets', async (req, res) => {
  const actor = actorFrom(res);
  const status = req.query.period;
  const period = typeof status === 'string' && periodSchema.safeParse(status).success ? status : null;
  if (status !== undefined && period === null) { invalid(res, { period: 'Expected YYYY-MM.' }); return; }
  const result = await pool.query(`
    SELECT b.id, b.department_id AS "departmentId", d.name AS "departmentName", b.period_key AS "periodKey",
           b.limit_minor::text AS "limitMinor", b.reserved_minor::text AS "reservedMinor",
           (b.limit_minor - b.reserved_minor)::text AS "availableMinor", o.currency_code AS "currencyCode",
           b.created_at AS "createdAt", b.updated_at AS "updatedAt"
    FROM budgets b JOIN departments d ON d.id = b.department_id AND d.organization_id = b.organization_id
    JOIN organizations o ON o.id = b.organization_id
    WHERE b.organization_id = $1 AND ($2::text = 'finance_admin' OR b.department_id = $3)
      AND ($4::text IS NULL OR b.period_key = $4)
    ORDER BY b.period_key DESC, d.name LIMIT 200
  `, [actor.organizationId, actor.role, actor.departmentId, period]);
  res.json({ budgets: result.rows });
});

businessRouter.get('/budgets/:id', async (req, res) => {
  const routeIdentifier = routeId(req.params.id);
  const actor = actorFrom(res);
  const budget = await getBudgetDetails(pool, routeIdentifier, actor.organizationId);
  if (!budget) { apiError(res, 404, 'BUDGET_NOT_FOUND', 'The requested budget was not found.'); return; }
  requireBudgetDepartment(actor, String(budget.departmentId));
  res.json({ budget });
});

businessRouter.post('/budgets', requireRole('finance_admin'), requireCsrf, async (req, res) => {
  const parsed = createBudgetSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error.flatten()); return; }
  const amount = parseMinorUnits(parsed.data.limitAmount);
  if (amount === null || amount <= 0n) { invalid(res, { limitAmount: 'The budget limit must be positive and have at most two decimals.' }); return; }
  const actor = actorFrom(res);
  const department = await pool.query('SELECT id FROM departments WHERE id = $1 AND organization_id = $2', [parsed.data.departmentId, actor.organizationId]);
  if (!department.rowCount) { apiError(res, 404, 'DEPARTMENT_NOT_FOUND', 'The requested department was not found.'); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query<{ id: string }>(`
      INSERT INTO budgets (organization_id, department_id, period_key, limit_minor, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5) RETURNING id
    `, [actor.organizationId, parsed.data.departmentId, parsed.data.periodKey, amount.toString(), actor.userId]);
    await addAudit(client, { organizationId: actor.organizationId, actorUserId: actor.userId, eventType: 'budget.created', details: { budgetId: created.rows[0]!.id, limitMinor: amount.toString(), periodKey: parsed.data.periodKey } });
    const budget = await getBudgetDetails(client, created.rows[0]!.id, actor.organizationId);
    await client.query('COMMIT');
    res.status(201).json({ budget });
  } catch (error) {
    await client.query('ROLLBACK');
    if (isPgUniqueViolation(error)) { apiError(res, 409, 'BUDGET_ALREADY_EXISTS', 'A budget already exists for this department and period.'); return; }
    throw error;
  } finally { client.release(); }
});

businessRouter.patch('/budgets/:id', requireRole('finance_admin'), requireCsrf, async (req, res) => {
  const routeIdentifier = routeId(req.params.id);
  const parsed = patchBudgetSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error.flatten()); return; }
  const limit = parseMinorUnits(parsed.data.limitAmount);
  if (limit === null || limit <= 0n) { invalid(res, { limitAmount: 'The budget limit must be positive and have at most two decimals.' }); return; }
  const actor = actorFrom(res);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const budget = await client.query<{ id: string; limit_minor: string; reserved_minor: string }>(
      'SELECT id, limit_minor::text, reserved_minor::text FROM budgets WHERE id = $1 AND organization_id = $2 FOR UPDATE', [routeIdentifier, actor.organizationId]);
    const row = budget.rows[0];
    if (!row) throw new HttpFault(404, 'BUDGET_NOT_FOUND', 'The requested budget was not found.');
    if (limit < BigInt(row.reserved_minor)) throw new HttpFault(409, 'BUDGET_LIMIT_BELOW_RESERVED', 'The budget limit cannot be below the amount already reserved.');
    await client.query('UPDATE budgets SET limit_minor = $1, updated_at = now() WHERE id = $2', [limit.toString(), row.id]);
    await addAudit(client, { organizationId: actor.organizationId, actorUserId: actor.userId, eventType: 'budget.limit_changed', details: { budgetId: row.id, previousLimitMinor: row.limit_minor, newLimitMinor: limit.toString() } });
    const updated = await getBudgetDetails(client, row.id, actor.organizationId);
    await client.query('COMMIT');
    res.json({ budget: updated });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

businessRouter.get('/requests', async (req, res) => {
  const actor = actorFrom(res);
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const validStatuses = ['draft', 'submitted', 'approved', 'rejected', 'cancelled'];
  if (status !== null && !validStatuses.includes(status)) { invalid(res, { status: 'Invalid request status.' }); return; }
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 100);
  const offset = Math.min(Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0), 10_000);
  const values: unknown[] = [actor.organizationId];
  let where = 'r.organization_id = $1';
  if (actor.role === 'employee') { values.push(actor.userId); where += ` AND r.requester_user_id = $${values.length}`; }
  else if (actor.role === 'approver') { values.push(actor.departmentId); where += ` AND r.department_id = $${values.length} AND (r.status <> 'draft' OR r.requester_user_id = $${values.length + 1})`; values.push(actor.userId); }
  if (status) { values.push(status); where += ` AND r.status = $${values.length}`; }
  if (query) { values.push(`%${escapeLike(query)}%`); where += ` AND (r.title ILIKE $${values.length} ESCAPE '\\' OR u.full_name ILIKE $${values.length} ESCAPE '\\')`; }
  values.push(limit, offset);
  const result = await pool.query(`
    SELECT r.id, r.title, r.description, r.amount_minor::text AS "amountMinor", r.status,
           r.department_id AS "departmentId", d.name AS "departmentName", r.requester_user_id AS "requesterUserId",
           u.full_name AS "requesterName", r.created_at AS "createdAt", r.submitted_at AS "submittedAt",
           r.decided_at AS "decidedAt", o.currency_code AS "currencyCode"
    FROM purchase_requests r JOIN departments d ON d.id = r.department_id AND d.organization_id = r.organization_id
    JOIN users u ON u.id = r.requester_user_id JOIN organizations o ON o.id = r.organization_id
    WHERE ${where} ORDER BY r.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}
  `, values);
  res.json({ requests: result.rows, page: { limit, offset, returned: result.rows.length } });
});

businessRouter.post('/requests', requireRole('employee', 'approver'), requireCsrf, async (req, res) => {
  const parsed = requestBodySchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error.flatten()); return; }
  const actor = actorFrom(res);
  if (!actor.departmentId) { apiError(res, 403, 'DEPARTMENT_REQUIRED', 'A department assignment is required to create requests.'); return; }
  const amount = parseMinorUnits(parsed.data.amount);
  if (amount === null || amount <= 0n || amount > 1_000_000_000_000n) { invalid(res, { amount: 'Amount must be positive, within the supported maximum, and have at most two decimals.' }); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const budget = await client.query(`SELECT id FROM budgets WHERE id = $1 AND organization_id = $2 AND department_id = $3`, [parsed.data.budgetId, actor.organizationId, actor.departmentId]);
    if (!budget.rowCount) throw new HttpFault(404, 'BUDGET_NOT_FOUND', 'Choose a budget available to your department.');
    const created = await client.query<{ id: string }>(`
      INSERT INTO purchase_requests (organization_id, department_id, budget_id, requester_user_id, title, description, amount_minor)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [actor.organizationId, actor.departmentId, parsed.data.budgetId, actor.userId, parsed.data.title, parsed.data.description, amount.toString()]);
    await addAudit(client, { organizationId: actor.organizationId, requestId: created.rows[0]!.id, actorUserId: actor.userId, eventType: 'request.created', toStatus: 'draft', details: { amountMinor: amount.toString() } });
    const request = await getRequestDetails(client, created.rows[0]!.id, actor.organizationId);
    await client.query('COMMIT');
    res.status(201).json({ request });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

businessRouter.get('/requests/:id', async (req, res) => {
  const routeIdentifier = routeId(req.params.id);
  const actor = actorFrom(res);
  const result = await pool.query<{ organization_id: string; department_id: string; requester_user_id: string; status: string }>(
    'SELECT organization_id, department_id, requester_user_id, status FROM purchase_requests WHERE id = $1 AND organization_id = $2', [routeIdentifier, actor.organizationId]);
  const row = result.rows[0];
  if (!row) { apiError(res, 404, 'REQUEST_NOT_FOUND', 'The requested record was not found.'); return; }
  assertActorCanSeeRequest(row, actor);
  const request = await getRequestDetails(pool, routeIdentifier, actor.organizationId);
  res.json({ request });
});

businessRouter.patch('/requests/:id', requireCsrf, requireRole('employee', 'approver'), async (req, res) => {
  const routeIdentifier = routeId(req.params.id);
  const parsed = updateDraftSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error.flatten()); return; }
  const actor = actorFrom(res);
  const values: unknown[] = [];
  const updates: string[] = [];
  if (parsed.data.title !== undefined) { values.push(parsed.data.title); updates.push(`title = $${values.length}`); }
  if (parsed.data.description !== undefined) { values.push(parsed.data.description); updates.push(`description = $${values.length}`); }
  if (parsed.data.amount !== undefined) {
    const amount = parseMinorUnits(parsed.data.amount);
    if (amount === null || amount <= 0n || amount > 1_000_000_000_000n) { invalid(res, { amount: 'Amount must be positive, within the supported maximum, and have at most two decimals.' }); return; }
    values.push(amount.toString()); updates.push(`amount_minor = $${values.length}`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<{ id: string; organization_id: string; department_id: string; requester_user_id: string; status: string }>(
      'SELECT id, organization_id, department_id, requester_user_id, status FROM purchase_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE', [routeIdentifier, actor.organizationId]);
    const row = existing.rows[0];
    if (!row) throw new HttpFault(404, 'REQUEST_NOT_FOUND', 'The requested record was not found.');
    assertActorCanSeeRequest(row, actor);
    if (row.requester_user_id !== actor.userId || row.status !== 'draft') throw new HttpFault(409, 'REQUEST_NOT_EDITABLE', 'Only the requester can edit a draft request.');
    values.push(row.id);
    await client.query(`UPDATE purchase_requests SET ${updates.join(', ')}, updated_at = now() WHERE id = $${values.length}`, values);
    await addAudit(client, { organizationId: actor.organizationId, requestId: row.id, actorUserId: actor.userId, eventType: 'request.updated', fromStatus: 'draft', toStatus: 'draft', details: { fields: Object.keys(parsed.data) } });
    const request = await getRequestDetails(client, row.id, actor.organizationId);
    await client.query('COMMIT');
    res.json({ request });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

businessRouter.post('/requests/:id/submit', requireCsrf, requireRole('employee', 'approver'), async (req, res) => {
  const routeIdentifier = routeId(req.params.id);
  const parsedBody = emptySchema.safeParse(req.body ?? {});
  if (!parsedBody.success) { invalid(res, parsedBody.error.flatten()); return; }
  const actor = actorFrom(res);
  await preflightRequestAccess(actor, routeIdentifier, 'submit');
  const outcome = await runIdempotentMutation({ actor, operationName: `request.submit:${routeIdentifier}`, key: String(req.header('Idempotency-Key') ?? ''), payload: {}, work: async (client, operationId): Promise<MutationResult> => {
    const existing = await client.query<{ id: string; organization_id: string; department_id: string; requester_user_id: string; status: string }>(
      'SELECT id, organization_id, department_id, requester_user_id, status FROM purchase_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE', [routeIdentifier, actor.organizationId]);
    const row = existing.rows[0];
    if (!row) throw new HttpFault(404, 'REQUEST_NOT_FOUND', 'The requested record was not found.');
    assertActorCanSeeRequest(row, actor);
    if (row.requester_user_id !== actor.userId) throw new HttpFault(403, 'REQUEST_OWNER_REQUIRED', 'Only the requester can submit this request.');
    if (row.status !== 'draft') throw new HttpFault(409, 'INVALID_STATE_TRANSITION', 'Only draft requests can be submitted.');
    await client.query("UPDATE purchase_requests SET status = 'submitted', submitted_at = now(), updated_at = now() WHERE id = $1", [row.id]);
    await addAudit(client, { organizationId: actor.organizationId, requestId: row.id, actorUserId: actor.userId, operationId, eventType: 'request.submitted', fromStatus: 'draft', toStatus: 'submitted' });
    return { status: 200, body: { request: await getRequestDetails(client, row.id, actor.organizationId) } };
  } });
  res.setHeader('Idempotency-Replayed', String(outcome.replayed));
  res.status(outcome.status).json(outcome.body);
});

businessRouter.post('/requests/:id/approve', requireCsrf, requireRole('approver'), async (req, res) => {
  const routeIdentifier = routeId(req.params.id);
  const parsed = emptySchema.safeParse(req.body ?? {});
  if (!parsed.success) { invalid(res, parsed.error.flatten()); return; }
  const actor = actorFrom(res);
  await preflightRequestAccess(actor, routeIdentifier, 'approve');
  const outcome = await runIdempotentMutation({ actor, operationName: `request.approve:${routeIdentifier}`, key: String(req.header('Idempotency-Key') ?? ''), payload: {}, work: async (client, operationId): Promise<MutationResult> => {
    const existing = await client.query<{ id: string; organization_id: string; department_id: string; requester_user_id: string; budget_id: string; amount_minor: string; status: string }>(
      'SELECT id, organization_id, department_id, requester_user_id, budget_id, amount_minor::text, status FROM purchase_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE', [routeIdentifier, actor.organizationId]);
    const row = existing.rows[0];
    if (!row) throw new HttpFault(404, 'REQUEST_NOT_FOUND', 'The requested record was not found.');
    assertActorCanSeeRequest(row, actor);
    if (row.department_id !== actor.departmentId) throw new HttpFault(404, 'REQUEST_NOT_FOUND', 'The requested record was not found.');
    if (row.requester_user_id === actor.userId) throw new HttpFault(403, 'SELF_APPROVAL_FORBIDDEN', 'You cannot approve your own request.');
    if (row.status !== 'submitted') throw new HttpFault(409, 'INVALID_STATE_TRANSITION', 'Only submitted requests can be approved.');
    const budgetResult = await client.query<{ id: string; limit_minor: string; reserved_minor: string }>(
      'SELECT id, limit_minor::text, reserved_minor::text FROM budgets WHERE id = $1 AND organization_id = $2 FOR UPDATE', [row.budget_id, actor.organizationId]);
    const budget = budgetResult.rows[0];
    if (!budget) throw new HttpFault(409, 'BUDGET_UNAVAILABLE', 'The request budget is no longer available.');
    const amount = BigInt(row.amount_minor);
    if (BigInt(budget.limit_minor) - BigInt(budget.reserved_minor) < amount) throw new HttpFault(409, 'INSUFFICIENT_BUDGET', 'The available budget is insufficient for this request.');
    await client.query("INSERT INTO reservations (organization_id, budget_id, request_id, amount_minor, status) VALUES ($1, $2, $3, $4, 'active')", [actor.organizationId, row.budget_id, row.id, amount.toString()]);
    const updatedBudget = await client.query(`UPDATE budgets SET reserved_minor = reserved_minor + $1::bigint, updated_at = now() WHERE id = $2 AND reserved_minor + $1::bigint <= limit_minor RETURNING id`, [amount.toString(), row.budget_id]);
    if (!updatedBudget.rowCount) throw new HttpFault(409, 'INSUFFICIENT_BUDGET', 'The available budget changed. Refresh and try again.');
    await client.query("UPDATE purchase_requests SET status = 'approved', decided_at = now(), updated_at = now() WHERE id = $1", [row.id]);
    await addAudit(client, { organizationId: actor.organizationId, requestId: row.id, actorUserId: actor.userId, operationId, eventType: 'request.approved', fromStatus: 'submitted', toStatus: 'approved', details: { amountMinor: amount.toString(), budgetId: row.budget_id } });
    return { status: 200, body: { request: await getRequestDetails(client, row.id, actor.organizationId) } };
  } });
  res.setHeader('Idempotency-Replayed', String(outcome.replayed));
  res.status(outcome.status).json(outcome.body);
});

businessRouter.post('/requests/:id/reject', requireCsrf, requireRole('approver'), async (req, res) => {
  const routeIdentifier = routeId(req.params.id);
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error.flatten()); return; }
  const actor = actorFrom(res);
  await preflightRequestAccess(actor, routeIdentifier, 'reject');
  const outcome = await runIdempotentMutation({ actor, operationName: `request.reject:${routeIdentifier}`, key: String(req.header('Idempotency-Key') ?? ''), payload: parsed.data, work: async (client, operationId): Promise<MutationResult> => {
    const existing = await client.query<{ id: string; organization_id: string; department_id: string; requester_user_id: string; status: string }>(
      'SELECT id, organization_id, department_id, requester_user_id, status FROM purchase_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE', [routeIdentifier, actor.organizationId]);
    const row = existing.rows[0];
    if (!row) throw new HttpFault(404, 'REQUEST_NOT_FOUND', 'The requested record was not found.');
    assertActorCanSeeRequest(row, actor);
    if (row.department_id !== actor.departmentId) throw new HttpFault(404, 'REQUEST_NOT_FOUND', 'The requested record was not found.');
    if (row.requester_user_id === actor.userId) throw new HttpFault(403, 'SELF_APPROVAL_FORBIDDEN', 'You cannot reject your own request.');
    if (row.status !== 'submitted') throw new HttpFault(409, 'INVALID_STATE_TRANSITION', 'Only submitted requests can be rejected.');
    await client.query("UPDATE purchase_requests SET status = 'rejected', decided_at = now(), rejection_reason = $1, updated_at = now() WHERE id = $2", [parsed.data.reason, row.id]);
    await addAudit(client, { organizationId: actor.organizationId, requestId: row.id, actorUserId: actor.userId, operationId, eventType: 'request.rejected', fromStatus: 'submitted', toStatus: 'rejected', reason: parsed.data.reason });
    return { status: 200, body: { request: await getRequestDetails(client, row.id, actor.organizationId) } };
  } });
  res.setHeader('Idempotency-Replayed', String(outcome.replayed));
  res.status(outcome.status).json(outcome.body);
});

businessRouter.post('/requests/:id/cancel', requireCsrf, async (req, res) => {
  const routeIdentifier = routeId(req.params.id);
  const parsed = emptySchema.safeParse(req.body ?? {});
  if (!parsed.success) { invalid(res, parsed.error.flatten()); return; }
  const actor = actorFrom(res);
  await preflightRequestAccess(actor, routeIdentifier, 'cancel');
  const outcome = await runIdempotentMutation({ actor, operationName: `request.cancel:${routeIdentifier}`, key: String(req.header('Idempotency-Key') ?? ''), payload: {}, work: async (client, operationId): Promise<MutationResult> => {
    const existing = await client.query<{ id: string; organization_id: string; department_id: string; requester_user_id: string; budget_id: string; status: string }>(
      'SELECT id, organization_id, department_id, requester_user_id, budget_id, status FROM purchase_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE', [routeIdentifier, actor.organizationId]);
    const row = existing.rows[0];
    if (!row) throw new HttpFault(404, 'REQUEST_NOT_FOUND', 'The requested record was not found.');
    assertActorCanSeeRequest(row, actor);
    if (actor.role !== 'finance_admin' && row.requester_user_id !== actor.userId) throw new HttpFault(403, 'REQUEST_OWNER_REQUIRED', 'Only the requester or finance administrator can cancel this request.');
    if (!['draft', 'submitted', 'approved'].includes(row.status)) throw new HttpFault(409, 'INVALID_STATE_TRANSITION', 'This request cannot be cancelled from its current state.');
    if (row.status === 'approved') {
      const budgetResult = await client.query<{ limit_minor: string; reserved_minor: string }>('SELECT limit_minor::text, reserved_minor::text FROM budgets WHERE id = $1 AND organization_id = $2 FOR UPDATE', [row.budget_id, actor.organizationId]);
      const budget = budgetResult.rows[0];
      if (!budget) throw new HttpFault(409, 'BUDGET_UNAVAILABLE', 'The request budget is no longer available.');
      const reservation = await client.query<{ id: string; amount_minor: string }>("SELECT id, amount_minor::text FROM reservations WHERE request_id = $1 AND status = 'active' FOR UPDATE", [row.id]);
      const active = reservation.rows[0];
      if (!active || BigInt(budget.reserved_minor) < BigInt(active.amount_minor)) throw new HttpFault(409, 'RESERVATION_INVARIANT_FAILED', 'The reservation could not be safely released. Contact the project administrator.');
      await client.query("UPDATE reservations SET status = 'released', released_at = now() WHERE id = $1", [active.id]);
      await client.query('UPDATE budgets SET reserved_minor = reserved_minor - $1::bigint, updated_at = now() WHERE id = $2', [active.amount_minor, row.budget_id]);
    }
    await client.query("UPDATE purchase_requests SET status = 'cancelled', updated_at = now() WHERE id = $1", [row.id]);
    await addAudit(client, { organizationId: actor.organizationId, requestId: row.id, actorUserId: actor.userId, operationId, eventType: 'request.cancelled', fromStatus: row.status, toStatus: 'cancelled', details: { reservationReleased: row.status === 'approved' } });
    return { status: 200, body: { request: await getRequestDetails(client, row.id, actor.organizationId) } };
  } });
  res.setHeader('Idempotency-Replayed', String(outcome.replayed));
  res.status(outcome.status).json(outcome.body);
});

businessRouter.get('/requests/:id/audit', async (req, res) => {
  const routeIdentifier = routeId(req.params.id);
  const actor = actorFrom(res);
  const requestResult = await pool.query<{ organization_id: string; department_id: string; requester_user_id: string; status: string }>(
    'SELECT organization_id, department_id, requester_user_id, status FROM purchase_requests WHERE id = $1 AND organization_id = $2', [routeIdentifier, actor.organizationId]);
  const request = requestResult.rows[0];
  if (!request) { apiError(res, 404, 'REQUEST_NOT_FOUND', 'The requested record was not found.'); return; }
  assertActorCanSeeRequest(request, actor);
  const result = await pool.query(`
    SELECT a.id, a.event_type AS "eventType", a.from_status AS "fromStatus", a.to_status AS "toStatus", a.reason,
           a.details, a.created_at AS "createdAt", u.full_name AS "actorName", u.email AS "actorEmail"
    FROM audit_events a JOIN users u ON u.id = a.actor_user_id
    WHERE a.organization_id = $1 AND a.request_id = $2 ORDER BY a.created_at ASC, a.id ASC
  `, [actor.organizationId, routeIdentifier]);
  res.json({ events: result.rows });
});

businessRouter.get('/audit', requireRole('finance_admin'), async (req, res) => {
  const actor = actorFrom(res);
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 100);
  const result = await pool.query(`
    SELECT a.id, a.event_type AS "eventType", a.request_id AS "requestId", a.from_status AS "fromStatus", a.to_status AS "toStatus",
           a.reason, a.details, a.created_at AS "createdAt", u.full_name AS "actorName", u.email AS "actorEmail"
    FROM audit_events a JOIN users u ON u.id = a.actor_user_id
    WHERE a.organization_id = $1 ORDER BY a.created_at DESC LIMIT $2
  `, [actor.organizationId, limit]);
  res.json({ events: result.rows });
});

function isPgUniqueViolation(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '23505';
}
function escapeLike(input: string) { return input.replace(/[\\%_]/g, '\\$&'); }
