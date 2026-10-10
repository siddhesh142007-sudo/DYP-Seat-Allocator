import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { env } from '../config/env.js';

/**
 * Runs `fn` inside an interactive transaction with an explicit timeout.
 *
 * Prisma's default interactive-transaction timeout is 5 s. That is fine against
 * a local Postgres, but a remote database (Neon, Supabase, RDS) can exceed it on
 * a cold connection or a slow query — Prisma then aborts with
 * `P2028 Transaction already closed`, which surfaces as a 500 on seat
 * generation, imports, exam creation and publish.
 *
 * Use this instead of `prisma.$transaction(...)` so one setting covers every
 * transactional code path. `maxWait` bounds how long we wait for a free
 * connection before giving up.
 */
export function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeout?: number; maxWait?: number } = {},
): Promise<T> {
  return prisma.$transaction(fn, {
    timeout: options.timeout ?? env.DB_TRANSACTION_TIMEOUT_MS,
    maxWait: options.maxWait ?? env.DB_TRANSACTION_TIMEOUT_MS,
  });
}