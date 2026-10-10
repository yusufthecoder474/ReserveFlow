import { fingerprint } from './fingerprint.js';
import type { PoolClient } from 'pg';
import type { Actor } from './auth.js';
import { pool } from '../database.js';

export class HttpFault extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'HttpFault';
  }
}

export type MutationResult = { status: number; body: Record<string, unknown> };
export type IdempotentResult = MutationResult & { replayed: boolean };

export async function runIdempotentMutation(input: {
  actor: Actor;
  operationName: string;
  key: string;
  payload: unknown;
  work: (client: PoolClient, operationId: string) => Promise<MutationResult>;
}): Promise<IdempotentResult> {
  if (input.key.length < 8 || input.key.length > 200 || !/^[\x21-\x7e]+$/.test(input.key)) {
    throw new HttpFault(400, 'INVALID_IDEMPOTENCY_KEY', 'Provide an Idempotency-Key between 8 and 200 printable ASCII characters.');
  }
  const requestFingerprint = fingerprint(input.payload);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO idempotency_records
        (organization_id, actor_user_id, operation_name, idempotency_key, request_fingerprint, response_status, response_body)
      VALUES ($1, $2, $3, $4, $5, 200, '{}'::jsonb)
      ON CONFLICT (organization_id, actor_user_id, operation_name, idempotency_key) DO NOTHING
      RETURNING id
    `, [input.actor.organizationId, input.actor.userId, input.operationName, input.key, requestFingerprint]);

    if (inserted.rowCount === 0) {
      const existing = await client.query<{ request_fingerprint: string; response_status: number; response_body: Record<string, unknown> }>(`
        SELECT request_fingerprint, response_status, response_body
        FROM idempotency_records
        WHERE organization_id = $1 AND actor_user_id = $2 AND operation_name = $3 AND idempotency_key = $4
        FOR UPDATE
      `, [input.actor.organizationId, input.actor.userId, input.operationName, input.key]);
      const row = existing.rows[0];
      if (!row) throw new HttpFault(409, 'IDEMPOTENCY_RESULT_UNAVAILABLE', 'The operation result is not available. Retry with a new key after checking request status.');
      if (row.request_fingerprint !== requestFingerprint) {
        throw new HttpFault(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different request.');
      }
      await client.query('COMMIT');
      return { status: row.response_status, body: row.response_body, replayed: true };
    }

    const operationId = inserted.rows[0]!.id;
    const result = await input.work(client, operationId);
    await client.query(`
      UPDATE idempotency_records SET response_status = $1, response_body = $2::jsonb WHERE id = $3
    `, [result.status, JSON.stringify(result.body), operationId]);
    await client.query('COMMIT');
    return { ...result, replayed: false };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  } finally {
    client.release();
  }
}
