import type { User } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { UnauthorizedError, ValidationError } from '../../common/errors.js';
import { auditLog } from '../audit/audit.service.js';
import {
  decodeRefreshToken,
  hashPassword,
  issueSession,
  verifyPassword,
  type PublicUser,
  type SessionTokens,
} from './auth.utils.js';

/** Identical message for unknown user, wrong password and inactive account. */
const GENERIC_LOGIN_ERROR = 'Invalid email or password';

export function publicUser(user: User): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    studentId: user.studentId,
    mustChangePassword: user.mustChangePassword,
  };
}

export interface LoginResult extends SessionTokens {
  user: PublicUser;
}

export async function login(identifier: string, password: string, ip: string | null): Promise<LoginResult> {
  const ident = identifier.trim();
  const insensitive = { equals: ident, mode: 'insensitive' as const } as const;
  const where = ident.includes('@')
    ? // Email may live on the user row or on the linked student row.
      { OR: [{ email: insensitive }, { student: { email: insensitive } }] }
    : { student: { rollNumber: insensitive } };

  const user = await prisma.user.findFirst({ where });

  // Always run the compare (dummy hash for unknown users) so response time
  // does not reveal whether the account exists.
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? null);
  const ok = user?.status === 'ACTIVE' && passwordOk;

  if (!ok || !user) {
    const reason = !user ? 'unknown_user' : user.status !== 'ACTIVE' ? 'inactive' : 'bad_password';
    await auditLog({
      actorUserId: user?.id ?? null,
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: user?.id ?? null,
      metadata: { identifier: ident, reason },
      ip,
    });
    throw new UnauthorizedError(GENERIC_LOGIN_ERROR);
  }

  const session = issueSession(user);
  await auditLog({
    actorUserId: user.id,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    ip,
  });
  return { ...session, user: publicUser(user) };
}

export async function refresh(refreshToken: string): Promise<LoginResult> {
  const claims = decodeRefreshToken(refreshToken);
  if (!claims) throw new UnauthorizedError('Invalid or expired refresh token');

  const user = await prisma.user.findUnique({ where: { id: claims.sub } });
  if (!user || user.status !== 'ACTIVE' || user.tokenVersion !== claims.tv) {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  const session = issueSession(user);
  return { ...session, user: publicUser(user) };
}

/**
 * Idempotent logout. A valid refresh token bumps `token_version`, which
 * revokes every refresh token issued before it (single-account tool: logout
 * ends all sessions for that account).
 */
export async function logout(refreshToken: string | null, ip: string | null): Promise<void> {
  if (!refreshToken) return;
  const claims = decodeRefreshToken(refreshToken);
  if (!claims) return;

  const user = await prisma.user.findUnique({ where: { id: claims.sub } });
  if (!user || user.tokenVersion !== claims.tv) return;

  await prisma.user.update({
    where: { id: user.id },
    data: { tokenVersion: { increment: 1 } },
  });
  await auditLog({
    actorUserId: user.id,
    action: 'auth.logout',
    entityType: 'user',
    entityId: user.id,
    ip,
  });
}

export async function me(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== 'ACTIVE') {
    throw new UnauthorizedError('Session is no longer valid');
  }
  return publicUser(user);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  ip: string | null,
): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== 'ACTIVE') {
    throw new UnauthorizedError('Session is no longer valid');
  }

  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    throw new ValidationError('Current password is incorrect');
  }
  if (currentPassword === newPassword) {
    throw new ValidationError('New password must be different from the current one');
  }

  // tokenVersion bump revokes every previously issued refresh token; a fresh
  // session is issued below so the caller stays signed in (and the
  // must-change-password flag is cleared).
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(newPassword),
      tokenVersion: { increment: 1 },
      mustChangePassword: false,
    },
  });
  await auditLog({
    actorUserId: user.id,
    action: 'auth.change_password',
    entityType: 'user',
    entityId: user.id,
    ip,
  });
  return { ...issueSession(updated), user: publicUser(updated) };
}
