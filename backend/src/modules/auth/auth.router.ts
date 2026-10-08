import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../common/asyncHandler.js';
import { loginSchema, changePasswordSchema } from './auth.schemas.js';
import { authenticate } from './auth.middleware.js';
import * as authService from './auth.service.js';
import { clearRefreshCookie, setRefreshCookie } from './auth.utils.js';

export const authRouter = Router();

function clientIp(req: { ip?: string }): string | null {
  return req.ip ?? null;
}

function refreshCookie(req: { cookies?: Record<string, string | undefined> }): string | null {
  return req.cookies?.[env.REFRESH_COOKIE_NAME] ?? null;
}

/**
 * Strict per-identifier limiter on login: counts only FAILED attempts within
 * the window (successful logins do not consume budget), keyed by identifier
 * so one account cannot lock out another. The global per-IP limiter in
 * app.ts covers IP-spray attacks.
 */
const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: env.AUTH_RATE_LIMIT_MAX,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String((req.body as { identifier?: string } | undefined)?.identifier ?? '').toLowerCase(),
  message: { error: { code: 'RATE_LIMITED', message: 'Too many failed login attempts. Try again in a minute.', details: null } },
});

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const result = await authService.login(body.identifier, body.password, clientIp(req));
    setRefreshCookie(res, result.refreshToken);
    res.status(200).json({ accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = refreshCookie(req);
    if (!token) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token', details: null } });
      return;
    }
    const result = await authService.refresh(token);
    setRefreshCookie(res, result.refreshToken);
    res.status(200).json({ accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await authService.logout(refreshCookie(req), clientIp(req));
    clearRefreshCookie(res);
    res.status(200).json({ message: 'Signed out' });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await authService.me(req.auth!.userId);
    res.json({ user });
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const body = changePasswordSchema.parse(req.body);
    const result = await authService.changePassword(req.auth!.userId, body.currentPassword, body.newPassword, clientIp(req));
    // Fresh session: old refresh tokens were revoked by the tokenVersion bump.
    setRefreshCookie(res, result.refreshToken);
    res.json({
      message: 'Password changed',
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    });
  }),
);
