import { Router, type Request, type Response } from 'express';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import { asyncHandler } from '../../common/asyncHandler.js';
import * as service from './dashboard.service.js';

export const dashboardRouter = Router();

const adminOnly = requireRole('EXAM_ADMIN', 'SUPER_ADMIN');

dashboardRouter.use(authenticate);

dashboardRouter.get(
  '/summary',
  adminOnly,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await service.getSummary());
  }),
);

dashboardRouter.get(
  '/charts',
  adminOnly,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await service.getCharts());
  }),
);
