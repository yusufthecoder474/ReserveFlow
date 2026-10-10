import { Pool } from 'pg';
import { env } from './config.js';
import { logger } from './logger.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 3_000,
  idleTimeoutMillis: 30_000,
  application_name: 'reserveflow-api'
});

pool.on('error', (error: Error) => {
  // Never log SQL parameters or request payloads here.
  logger.error({ err: error }, 'Unexpected idle PostgreSQL client error');
});
