import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler.js';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import { listAuditLogs } from './audit.service.js';

export const auditRouter = Router();

const auditQuerySchema = z.object({
  action: z.string().trim().max(100).optional(),
  entityType: z.string().trim().max(100).optional(),
  entityId: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

auditRouter.get(
  '/',
  authenticate,
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const query = auditQuerySchema.parse(req.query);
    res.json(await listAuditLogs(query));
  }),
);
