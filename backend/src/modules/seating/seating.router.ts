import { Router, type Request, type Response } from 'express';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import { asyncHandler } from '../../common/asyncHandler.js';
import * as service from './seating.service.js';
import { generateSeatingSchema, regenerateSeatingSchema, unpublishSchema } from './seating.schemas.js';

export const seatingRouter = Router();

function parseId(raw: string | undefined): string {
  return raw ?? '';
}

const adminOnly = requireRole('EXAM_ADMIN', 'SUPER_ADMIN');
const superAdminOnly = requireRole('SUPER_ADMIN');

seatingRouter.use(authenticate);

seatingRouter.post(
  '/exams/:id/generate-seating',
  adminOnly,
  asyncHandler(async (req: Request, res: Response) => {
    const body = generateSeatingSchema.parse(req.body ?? {});
    const result = await service.generateSeatingForExam(
      parseId(req.params.id),
      req.auth!.userId,
      body,
      req.ip ?? null,
    );
    res.json({ result });
  }),
);

seatingRouter.post(
  '/exams/:id/regenerate-seating',
  adminOnly,
  asyncHandler(async (req: Request, res: Response) => {
    const body = regenerateSeatingSchema.parse(req.body ?? {});
    const result = await service.regenerateSeatingForExam(
      parseId(req.params.id),
      req.auth!.userId,
      body,
      req.auth!.role,
      req.ip ?? null,
    );
    res.json({ result });
  }),
);

seatingRouter.get(
  '/exams/:id/seating',
  adminOnly,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await service.getSeating(parseId(req.params.id)));
  }),
);

seatingRouter.get(
  '/exams/:id/seating/validate',
  adminOnly,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await service.getSeatingValidation(parseId(req.params.id)));
  }),
);

seatingRouter.get(
  '/exams/:id/seating/runs',
  adminOnly,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await service.listRuns(parseId(req.params.id)));
  }),
);

seatingRouter.post(
  '/exams/:id/publish',
  adminOnly,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await service.publishSeating(parseId(req.params.id), req.auth!.userId, req.ip ?? null));
  }),
);

seatingRouter.post(
  '/exams/:id/unpublish',
  superAdminOnly,
  asyncHandler(async (req: Request, res: Response) => {
    const body = unpublishSchema.parse(req.body ?? {});
    res.json(
      await service.unpublishSeating(parseId(req.params.id), req.auth!.userId, body.reason, req.ip ?? null),
    );
  }),
);

seatingRouter.get(
  '/students/:id/seating-history',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await service.studentSeatingHistory(parseId(req.params.id)));
  }),
);
