import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { httpLogger, notFoundHandler, errorHandler } from './common/middleware/errorHandler.js';
import { healthRouter } from './modules/health/health.router.js';
import { authRouter } from './modules/auth/auth.router.js';
import { usersRouter } from './modules/users/users.router.js';
import { auditRouter } from './modules/audit/audit.router.js';
import { academicYearsRouter } from './modules/academic-years/academicYears.router.js';
import { departmentsRouter } from './modules/departments/departments.router.js';
import { studentsRouter } from './modules/students/students.router.js';
import { classroomsRouter } from './modules/classrooms/classrooms.router.js';
import { examsRouter } from './modules/exams/exams.router.js';
import { seatingRouter } from './modules/seating/seating.router.js';
import { dashboardRouter } from './modules/dashboard/dashboard.router.js';
import { exportsRouter } from './modules/exports/exports.router.js';
import { dypitRouter } from './modules/dypit/dypit.router.js';

/**
 * True when `origin` addresses the same host that served the request.
 *
 * Same-origin browser requests still send an Origin header, which a fixed
 * allowlist cannot match: every Vercel preview deployment gets a unique
 * hostname. Comparing hosts keeps those working without opening CORS to third
 * parties — only a request served from the very same host passes.
 */
function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors((req, cb) => {
      const origin = req.headers.origin;
      // Allow same-origin / no-origin requests (curl, server-to-server),
      // explicitly configured origins, and same-host preview deployments.
      const allowed =
        !origin ||
        env.corsOrigins.includes(origin) ||
        isSameOrigin(origin, req.headers.host);

      cb(null, { origin: allowed ? (origin ?? true) : false, credentials: true });
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());
  app.use(httpLogger);

  if (env.NODE_ENV !== 'test') {
    app.use(
      '/api',
      rateLimit({
        windowMs: env.RATE_LIMIT_WINDOW_MS,
        max: env.RATE_LIMIT_MAX,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: { code: 'RATE_LIMITED', message: 'Too many requests', details: null } },
      }),
    );
  }

  app.use('/api/v1/health', healthRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/audit-logs', auditRouter);
  app.use('/api/v1/academic-years', academicYearsRouter);
  app.use('/api/v1/departments', departmentsRouter);
  app.use('/api/v1/students', studentsRouter);
  app.use('/api/v1/classrooms', classroomsRouter);
  app.use('/api/v1/exams', examsRouter);
  app.use('/api/v1/seating', seatingRouter);
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use('/api/v1/exports', exportsRouter);
  // DYPIT range-based allocation builder (administrator only).
  app.use('/api/v1/dypit', dypitRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
