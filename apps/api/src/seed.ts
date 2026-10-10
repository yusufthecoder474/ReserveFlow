import { env } from './config.js';
import { pool } from './database.js';
import { hashPassword } from './lib/password.js';

async function seed() {
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed demo users in production.');
  const password = env.RESERVEFLOW_SEED_PASSWORD;
  if (!password || password.length < 12) throw new Error('Set RESERVEFLOW_SEED_PASSWORD to a local-only password of at least 12 characters.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const org1 = (await client.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, currency_code) VALUES ('northstar-demo', 'Northstar Demo Ltd', 'AED')
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id
    `)).rows[0]!;
    const org2 = (await client.query<{ id: string }>(`
      INSERT INTO organizations (slug, name, currency_code) VALUES ('otherco-demo', 'OtherCo Demo', 'SAR')
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id
    `)).rows[0]!;

    const dept1 = (await client.query<{ id: string }>(`
      INSERT INTO departments (organization_id, name) VALUES ($1, 'Operations')
      ON CONFLICT (organization_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id
    `, [org1.id])).rows[0]!;
    const dept2 = (await client.query<{ id: string }>(`
      INSERT INTO departments (organization_id, name) VALUES ($1, 'Operations')
      ON CONFLICT (organization_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id
    `, [org2.id])).rows[0]!;

    const users = [
      { email: 'employee@reserveflow.local', fullName: 'Ava Employee', orgId: org1.id, deptId: dept1.id, role: 'employee' },
      { email: 'approver@reserveflow.local', fullName: 'Arjun Approver', orgId: org1.id, deptId: dept1.id, role: 'approver' },
      { email: 'finance@reserveflow.local', fullName: 'Mina Finance', orgId: org1.id, deptId: null, role: 'finance_admin' },
      { email: 'employee@otherco.local', fullName: 'Noah OtherCo', orgId: org2.id, deptId: dept2.id, role: 'employee' }
    ] as const;

    for (const user of users) {
      const passwordHash = await hashPassword(password);
      const savedUser = (await client.query<{ id: string }>(`
        INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3)
        ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, password_hash = EXCLUDED.password_hash, is_active = true, updated_at = now()
        RETURNING id
      `, [user.email, user.fullName, passwordHash])).rows[0]!;
      await client.query(`
        INSERT INTO memberships (organization_id, user_id, department_id, role) VALUES ($1, $2, $3, $4)
        ON CONFLICT (organization_id, user_id) DO UPDATE SET department_id = EXCLUDED.department_id, role = EXCLUDED.role
      `, [user.orgId, savedUser.id, user.deptId, user.role]);
    }

    const financeUser = (await client.query<{ id: string }>(`
      SELECT user_id AS id FROM memberships WHERE organization_id = $1 AND role = 'finance_admin' LIMIT 1
    `, [org1.id])).rows[0]!;
    const currentPeriod = new Date().toISOString().slice(0, 7);
    await client.query(`
      INSERT INTO budgets (organization_id, department_id, period_key, limit_minor, reserved_minor, created_by_user_id)
      VALUES ($1, $2, $3, 500000, 0, $4)
      ON CONFLICT (department_id, period_key) DO NOTHING
    `, [org1.id, dept1.id, currentPeriod, financeUser.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  process.stdout.write('Seed complete. Demo password is the configured RESERVEFLOW_SEED_PASSWORD.\n');
  process.stdout.write('Accounts: employee@reserveflow.local, approver@reserveflow.local, finance@reserveflow.local, employee@otherco.local\n');
}

seed().catch((error: unknown) => {
  process.stderr.write(`Seed failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
}).finally(async () => pool.end());
