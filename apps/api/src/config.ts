import { config as loadDotEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
loadDotEnv({ path: resolve(currentDirectory, '../../../.env') });

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGIN: z.url().default('http://127.0.0.1:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  SESSION_COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  RESERVEFLOW_SEED_PASSWORD: z.string().min(12).optional(),
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((value) => value === 'true')
});

const parsedEnvironment = environmentSchema.safeParse(process.env);
if (!parsedEnvironment.success) {
  const issues = parsedEnvironment.error.issues.map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${issues}`);
}

if (parsedEnvironment.data.NODE_ENV === 'production' && !parsedEnvironment.data.SESSION_COOKIE_SECURE) {
  throw new Error('SESSION_COOKIE_SECURE=true is required in production. Serve the application over HTTPS.');
}

export const env = parsedEnvironment.data;
