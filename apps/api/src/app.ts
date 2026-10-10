import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { env } from './config.js';
import { pool } from './database.js';
import { logger } from './logger.js';
import { authRouter } from './routes/auth.js';
import { businessRouter } from './routes/business.js';
import { HttpFault } from './lib/idempotency.js';
import { apiError } from './lib/http.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info({ requestId, method: req.method, path: req.path, statusCode: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000 }, 'HTTP request completed');
    });
    next();
  });

  app.use(express.json({ limit: '64kb', strict: true }));

  app.use((req, res, next) => {
    const origin = req.header('origin');
    if (origin === env.CORS_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Idempotency-Key');
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (unsafe && origin && origin !== env.CORS_ORIGIN) {
      apiError(res, 403, 'ORIGIN_NOT_ALLOWED', 'This request origin is not allowed.');
      return;
    }
    next();
  });

  app.get('/api/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'reserveflow-api' });
  });

  app.get('/api/health/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.status(200).json({ status: 'ready', dependencies: { postgres: 'ok' } });
    } catch (error) {
      logger.warn({ err: error, requestId: res.locals.requestId }, 'Readiness check failed');
      apiError(res, 503, 'DEPENDENCY_UNAVAILABLE', 'A required dependency is unavailable.');
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api', businessRouter);

  app.use((_req, res) => apiError(res, 404, 'ROUTE_NOT_FOUND', 'The requested route does not exist.'));

  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof HttpFault) {
      apiError(res, error.status, error.code, error.message, error.details);
      return;
    }
    const parserError = typeof error === 'object' && error !== null ? error as { type?: string } : {};
    if (parserError.type === 'entity.parse.failed') { apiError(res, 400, 'INVALID_JSON', 'The request body is not valid JSON.'); return; }
    if (parserError.type === 'entity.too.large') { apiError(res, 413, 'REQUEST_TOO_LARGE', 'The request body exceeds the allowed size.'); return; }
    logger.error({ err: error, requestId: res.locals.requestId }, 'Unhandled request error');
    apiError(res, 500, 'INTERNAL_SERVER_ERROR', 'An unexpected error occurred.');
  };
  app.use(errorHandler);
  return app;
}
