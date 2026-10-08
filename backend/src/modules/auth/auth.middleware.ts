import type { RequestHandler } from 'express';
import type { UserRole } from '@prisma/client';
import { ForbiddenError, UnauthorizedError } from '../../common/errors.js';
import { verifyAccessToken } from './auth.utils.js';

export interface AuthPayload {
  userId: string;
  role: UserRole;
  name: string;
  studentId: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `authenticate`; never trusted before then. */
    auth?: AuthPayload;
  }
}

/** Validates the Bearer access token and attaches the payload to `req.auth`. */
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(new UnauthorizedError('Authentication required'));
    return;
  }
  try {
    const claims = verifyAccessToken(header.slice(7));
    req.auth = {
      userId: claims.sub,
      role: claims.role,
      name: claims.name,
      studentId: claims.sid,
    };
    next();
  } catch (err) {
    next(err instanceof UnauthorizedError ? err : new UnauthorizedError('Authentication required'));
  }
};

/** Route guard: only the listed roles may pass (403 otherwise). */
export const requireRole =
  (...roles: UserRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }
    if (!roles.includes(req.auth.role)) {
      next(new ForbiddenError(`This action requires one of: ${roles.join(', ')}`));
      return;
    }
    next();
  };

/**
 * Resource-level check: a STUDENT may only touch the resource identified by
 * `param` when it belongs to them; admins pass. Mount after `authenticate`.
 */
export const requireSelfOrAdmin =
  (param = 'studentId'): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }
    if (req.auth.role === 'SUPER_ADMIN' || req.auth.role === 'EXAM_ADMIN') {
      next();
      return;
    }
    const target = req.params[param];
    if (req.auth.studentId && target && target === req.auth.studentId) {
      next();
      return;
    }
    next(new ForbiddenError('You can only access your own records'));
  };
