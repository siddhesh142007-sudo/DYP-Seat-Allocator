import { checkDb } from './pool.js';

/**
 * Cold-start handling for a scale-to-zero database.
 *
 * On a serverless platform a function instance can sit idle for minutes and
 * then receive a request. When the database has also scaled to zero, the first
 * query has to wait for it to resume — several seconds — and with a cold
 * connection pool it can fail outright instead of merely being slow.
 *
 * We therefore make the first request in each instance pay that wait
 * deliberately: `ensureDatabaseReady` pings with retries before any handler
 * runs, so the user sees one slow response rather than an error.
 *
 * If the database is genuinely unreachable we stop paying that penalty on every
 * subsequent request: the circuit breaker below latches open for a short
 * cooldown, so requests fail fast and recover on their own once it closes.
 */

const MAX_ATTEMPTS = 8;
const RETRY_DELAY_MS = 1000;
/** How long a failed warm-up keeps failing fast before we try again. */
const BREAKER_COOLDOWN_MS = 15_000;
/**
 * How long a successful check is trusted before re-verifying. A function
 * instance can stay warm while the database scales to zero underneath it, so
 * "we already warmed up" cannot mean "never check again".
 */
const WARM_TTL_MS = 60_000;

let warmedAt = 0;
let warming: Promise<void> | null = null;
let breakerOpenUntil = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface DatabaseReadiness {
  ready: boolean;
  /** True when the circuit breaker is open, i.e. we skipped the wait. */
  skipped: boolean;
}

/** Resets module state. Tests only. */
export function resetDatabaseWarmup(): void {
  warmedAt = 0;
  warming = null;
  breakerOpenUntil = 0;
}

/**
 * Ensures a usable database connection before a request is handled.
 *
 * Concurrent callers share one in-flight attempt rather than each starting
 * their own retry loop against a cold database.
 */
export async function ensureDatabaseReady(): Promise<DatabaseReadiness> {
  const now = Date.now();
  if (warmedAt && now - warmedAt < WARM_TTL_MS) {
    return { ready: true, skipped: false };
  }

  if (now < breakerOpenUntil) {
    return { ready: false, skipped: true };
  }

  if (!warming) {
    warming = (async () => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const health = await checkDb();
        if (health.up) {
          warmedAt = Date.now();
          breakerOpenUntil = 0;
          return;
        }
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      }
      breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    })().finally(() => {
      warming = null;
    });
  }

  await warming;
  return { ready: Boolean(warmedAt), skipped: false };
}