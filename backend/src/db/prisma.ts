import { PrismaClient } from '@prisma/client';

/**
 * Shared Prisma client. Reused across requests so connection pooling is
 * managed by Prisma itself; in test workers a fresh client is created per
 * process (no global reuse across isolated test files).
 */
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export const prisma = globalForPrisma.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'test') {
  globalForPrisma.__prisma = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
