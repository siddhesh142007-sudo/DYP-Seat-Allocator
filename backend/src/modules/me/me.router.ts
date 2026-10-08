import { Router, type Request, type Response, type RequestHandler } from 'express';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import { ForbiddenError } from '../../common/errors.js';
import { asyncHandler } from '../../common/asyncHandler.js';
import * as service from './me.service.js';
import { slipParamsSchema } from './me.schemas.js';

export const meRouter = Router();

/** STUDENT accounts must be linked to a students row to have a portal. */
const requireLinkedStudent: RequestHandler = (req, _res, next) => {
  if (!req.auth?.studentId) {
    next(new ForbiddenError('This account is not linked to a student record'));
    return;
  }
  next();
};

meRouter.use(authenticate);
meRouter.use(requireRole('STUDENT'));
meRouter.use(requireLinkedStudent);

meRouter.get(
  '/seating',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await service.mySeating(req.auth!.studentId!));
  }),
);

meRouter.get(
  '/seating/slip/:examId',
  asyncHandler(async (req: Request, res: Response) => {
    const { examId } = slipParamsSchema.parse(req.params);
    const { buffer, filename } = await service.mySlip(req.auth!.studentId!, examId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.byteLength));
    res.end(buffer);
  }),
);
