import { env } from '../config/env.js';
import { logger } from '../common/logger.js';
import { prisma } from '../db/prisma.js';
import { hashPassword } from '../modules/auth/auth.utils.js';

/**
 * Bootstrap seed: creates the first SUPER_ADMIN from env variables.
 * Idempotent — re-running never duplicates or overwrites an existing account.
 *
 *   SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD / SUPER_ADMIN_NAME
 *
 * Run with: npm run seed   (wired via the "prisma.seed" config in package.json)
 */
async function main(): Promise<void> {
  const { SUPER_ADMIN_EMAIL: email, SUPER_ADMIN_PASSWORD: password, SUPER_ADMIN_NAME: name } = env;

  if (!email || !password) {
    logger.warn('SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD not set — skipping super admin bootstrap');
    return;
  }
  if (password.length < 8) {
    throw new Error('SUPER_ADMIN_PASSWORD must be at least 8 characters');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    logger.info({ email, role: existing.role }, 'Super admin already exists — nothing to do');
    return;
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: name ?? 'Super Admin',
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      passwordHash: await hashPassword(password),
    },
  });
  logger.info({ email: user.email, id: user.id }, 'Bootstrapped super admin account');
}

main()
  .catch((err) => {
    logger.error({ err }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
