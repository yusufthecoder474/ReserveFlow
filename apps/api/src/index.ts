import { createApp } from './app.js';
import { env } from './config.js';
import { pool } from './database.js';
import { logger } from './logger.js';

const app = createApp();
const server = app.listen(env.PORT, env.HOST, () => {
  logger.info({ port: env.PORT }, 'ReserveFlow API listening');
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutdown requested');

  const forceCloseTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    process.exitCode = 1;
    server.closeAllConnections();
  }, 10_000);
  forceCloseTimer.unref();

  server.close(async (error) => {
    if (error) {
      logger.error({ err: error }, 'HTTP server close failed');
      process.exitCode = 1;
    }

    try {
      await pool.end();
    } catch (poolError) {
      logger.error({ err: poolError }, 'PostgreSQL pool close failed');
      process.exitCode = 1;
    } finally {
      clearTimeout(forceCloseTimer);
    }
  });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
