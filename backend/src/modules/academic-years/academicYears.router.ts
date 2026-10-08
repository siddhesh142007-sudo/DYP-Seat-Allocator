import { Router } from 'express';
import { asyncHandler } from '../../common/asyncHandler.js';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import { createAcademicYearSchema, updateAcademicYearSchema, idParamSchema } from './academicYears.schemas.js';
import * as service from './academicYears.service.js';

export const academicYearsRouter = Router();

academicYearsRouter.use(authenticate, requireRole('SUPER_ADMIN', 'EXAM_ADMIN'));

function parseId(raw: string | undefined): string {
  return idParamSchema.parse(raw ?? '');
}

academicYearsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await service.listAcademicYears());
  }),
);

academicYearsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createAcademicYearSchema.parse(req.body);
    res.status(201).json({ academicYear: await service.createAcademicYear(body, req.auth!.userId, req.ip ?? null) });
  }),
);

academicYearsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = updateAcademicYearSchema.parse(req.body);
    res.json({ academicYear: await service.updateAcademicYear(parseId(req.params.id), body, req.auth!.userId, req.ip ?? null) });
  }),
);

academicYearsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await service.deleteAcademicYear(parseId(req.params.id), req.auth!.userId, req.ip ?? null);
    res.json({ message: 'Academic year deleted' });
  }),
);
