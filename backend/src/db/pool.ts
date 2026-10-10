import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../common/logger.js';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      // Generous on purpose. This pool serves the health check and the shared
      // rate-limit counters, so a timeout here is what makes the whole API look
      // down. Against a pooled, scale-to-zero host (Neon) even a warm connection
      // can take ~3 s because PgBouncer has to wake and complete the TLS
      // handshake; 3 s was measurably not enough and failed intermittently.
      connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
    });
    pool.on('error', (err) => {
      // Prevent an idle-client error from crashing the process.
      logger.error({ err }, 'unexpected postgres pool error');
    });
  }
  return pool;
}

export interface DbHealth {
  up: boolean;
  latencyMs: number;
}

/** Pings the database. Never throws; reports status for the health endpoint. */
export async function checkDb(): Promise<DbHealth> {
  const start = performance.now();
  try {
    await getPool().query('SELECT 1');
    return { up: true, latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { up: false, latencyMs: Math.round(performance.now() - start) };
  }
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
