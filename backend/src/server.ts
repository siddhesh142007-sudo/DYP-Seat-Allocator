import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './common/logger.js';
import { closeDb } from './db/pool.js';

const app = createApp();

const server: Server = app.listen(env.PORT, () => {
  if (env.usingDevSecrets && env.NODE_ENV === 'production') {
    logger.fatal('JWT secrets must be set in production; refusing to start with dev secrets.');
    process.exit(1);
  }
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'server listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down gracefully');
  const force = setTimeout(() => {
    logger.error('forced shutdown (timeout)');
    process.exit(1);
  }, 10000);
  force.unref();
  server.close(async () => {
    try {
      await closeDb();
    } catch (err) {
      logger.error({ err }, 'error closing database pool');
    }
    logger.info('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled promise rejection');
});
