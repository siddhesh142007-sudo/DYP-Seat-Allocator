import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import type { EntityStatus, UserRole } from '@prisma/client';
import { env } from '../../config/env.js';
import { UnauthorizedError } from '../../common/errors.js';

/** Path the refresh cookie is scoped to — only auth endpoints receive it. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface PublicUser {
  id: string;
  name: string;
  email: string | null;
  role: UserRole;
  status: EntityStatus;
  studentId: string | null;
  /** True when the account still uses its default password and must rotate it. */
  mustChangePassword: boolean;
}

export interface AccessClaims {
  sub: string;
  role: UserRole;
  name: string;
  sid: string | null;
}

export interface RefreshClaims {
  sub: string;
  tv: number;
  jti: string;
}

export interface SessionTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

// ---------------------------------------------------------------------------
// Passwords — bcrypt (pure-JS bcryptjs, cost >= 12 enforced by env schema).
// Hashes are never logged and never leave the service in API responses.
// ---------------------------------------------------------------------------

let dummyHashPromise: Promise<string> | null = null;

/**
 * Verifies a password. When no stored hash exists (unknown user) a dummy
 * compare against a throwaway hash still runs, so unknown-user and
 * wrong-password attempts take a similar amount of time (no user-enumeration
 * timing oracle).
 */
export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) {
    dummyHashPromise ??= bcrypt.hash('timing-only-dummy-password', env.PASSWORD_HASH_COST);
    await bcrypt.compare(plain, await dummyHashPromise);
    return false;
  }
  return bcrypt.compare(plain, hash);
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.PASSWORD_HASH_COST);
}

// ---------------------------------------------------------------------------
// JWTs
// ---------------------------------------------------------------------------

export function signAccessToken(user: { id: string; role: UserRole; name: string; studentId?: string | null }): string {
  return jwt.sign({ role: user.role, name: user.name, sid: user.studentId ?? null, jti: randomUUID() }, env.jwtSecret, {
    subject: user.id,
    expiresIn: env.ACCESS_TOKEN_TTL,
  });
}

export function signRefreshToken(user: { id: string; tokenVersion: number }): string {
  return jwt.sign({ tv: user.tokenVersion, jti: randomUUID() }, env.jwtRefreshSecret, {
    subject: user.id,
    expiresIn: env.REFRESH_TOKEN_TTL,
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, env.jwtSecret);
  } catch {
    throw new UnauthorizedError('Invalid or expired access token');
  }
  if (typeof decoded === 'string' || !decoded.sub || typeof decoded.role !== 'string') {
    throw new UnauthorizedError('Invalid or expired access token');
  }
  return {
    sub: decoded.sub,
    role: decoded.role as UserRole,
    name: typeof decoded.name === 'string' ? decoded.name : '',
    sid: typeof decoded.sid === 'string' ? decoded.sid : null,
  };
}

/** Decodes a refresh token; returns null for any invalid/expired token. */
export function decodeRefreshToken(token: string): RefreshClaims | null {
  try {
    const decoded = jwt.verify(token, env.jwtRefreshSecret);
    if (typeof decoded === 'string' || !decoded.sub || typeof decoded.tv !== 'number') return null;
    return { sub: decoded.sub, tv: decoded.tv, jti: String(decoded.jti ?? '') };
  } catch {
    return null;
  }
}

export function issueSession(user: {
  id: string;
  role: UserRole;
  name: string;
  studentId?: string | null;
  tokenVersion: number;
}): SessionTokens {
  return {
    accessToken: signAccessToken(user),
    expiresIn: env.ACCESS_TOKEN_TTL,
    refreshToken: signRefreshToken(user),
  };
}

// ---------------------------------------------------------------------------
// Refresh cookie helpers (httpOnly + SameSite, scoped to /api/v1/auth)
// ---------------------------------------------------------------------------

function cookieBase() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: REFRESH_COOKIE_PATH,
  };
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(env.REFRESH_COOKIE_NAME, token, { ...cookieBase(), maxAge: env.REFRESH_TOKEN_TTL * 1000 });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(env.REFRESH_COOKIE_NAME, cookieBase());
}
