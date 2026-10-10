import type { Store } from 'express-rate-limit';
import pg from 'pg';
import { env } from '../config/env.js';
import { getPool } from '../db/pool.js';

/**
 * Postgres-backed store for express-rate-limit.
 *
 * The default MemoryStore keeps counters in the process, so on Vercel every
 * function instance enforces its own budget: the effective limit multiplies by
 * the number of warm instances. A login limiter meant to stop credential
 * stuffing therefore becomes far weaker the busier the deployment gets.
 *
 * Sharing the counters through the database makes the limit global. It also
 * means the limit survives an instance recycling, which is the whole point of
 * having one.
 *
 * Cost model: one tiny INSERT ... ON CONFLICT per counted request, rolled up
 * by a periodic cleanup. Fine for this application — an administration tool,
 * not a public API. A high-traffic service should use Redis instead.
 */

/** Table and statement names, also used by the migration. */
const TABLE = 'rate_limit_hits';

interface Options {
  windowMs: number;
}

let pool: pg.Pool | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;

function getStorePool(): pg.Pool {
  // Reuse the application's pool so the limiter never doubles the number of
  // database connections a warm instance holds.
  pool = getPool();
  return pool;
}

/** Drops expired rows periodically so the table cannot grow without bound. */
function startCleanup(): void {
  if (cleanupTimer) return;
  const interval = Math.max(env.RATE_LIMIT_WINDOW_MS * 2, 60_000);
  cleanupTimer = setInterval(() => {
    void getStorePool()
      .query(`DELETE FROM ${TABLE} WHERE expires_at < now()`)
      .catch(() => {
        // Cleanup is best-effort; a failure here must never affect requests.
      });
  }, interval);
  // Do not hold the process open just to expire counters.
  cleanupTimer.unref?.();
}

export function createRateLimitStore(): Store {
  let windowMs = 60_000;

  const store: Store = {
    async init(options: Options): Promise<void> {
      windowMs = options.windowMs;
      startCleanup();
    },

    async increment(key: string): Promise<{ totalHits: number; resetTime: Date }> {
      const now = Date.now();
      const resetTime = new Date(now + windowMs);
      const sql =
        `INSERT INTO ${TABLE} (key, hits, expires_at)
         VALUES ($1, 1, now() + ($2::bigint * interval '1 millisecond'))
         ON CONFLICT (key) DO UPDATE
           SET hits = ${TABLE}.hits + 1,
               expires_at = EXCLUDED.expires_at
         RETURNING hits, expires_at`;

      const res = await getStorePool().query<{ hits: string; expires_at: Date }>(sql, [key, windowMs]);
      const row = res.rows[0];
      if (!row) {
        // Should be impossible, but never fail a request over a counter.
        return { totalHits: 1, resetTime };
      }
      return { totalHits: Number(row.hits), resetTime: new Date(row.expires_at) };
    },

    async decrement(key: string): Promise<void> {
      await getStorePool().query(`UPDATE ${TABLE} SET hits = hits - 1 WHERE key = $1 AND hits > 0`, [
        key,
      ]);
    },

    async resetKey(key: string): Promise<void> {
      await getStorePool().query(`DELETE FROM ${TABLE} WHERE key = $1`, [key]);
    },

    async resetAll(): Promise<void> {
      await getStorePool().query(`DELETE FROM ${TABLE}`);
    },

    /** Called by express-rate-limit when it shuts a limiter down. */
    async shutdown(): Promise<void> {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
    },
  };

  return store;
}

/** Exposed for tests. */
export const RATE_LIMIT_TABLE = TABLE;