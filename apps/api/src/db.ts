import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool } from './database.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = resolve(here, '../../../db/migrations');

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const alreadyApplied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (alreadyApplied.rowCount) continue;
      let sql = await readFile(resolve(migrationsDirectory, file), 'utf8');
      sql = sql.replace(/^\s*BEGIN\s*;?/i, '').replace(/COMMIT\s*;?\s*$/i, '');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  migrate().then(async () => {
    process.stdout.write('ReserveFlow migrations applied.\n');
    await pool.end();
  }).catch(async (error: unknown) => {
    process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    await pool.end();
    process.exitCode = 1;
  });
}
