import pino from 'pino';
import { env } from './config.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'headers.cookie',
      'password',
      'token',
      'accessToken',
      'refreshToken'
    ],
    censor: '[REDACTED]'
  },
  base: {
    service: 'reserveflow-api',
    environment: env.NODE_ENV
  },
  timestamp: pino.stdTimeFunctions.isoTime
});
