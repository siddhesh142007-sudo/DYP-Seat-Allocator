import { Router } from 'express';
import { asyncHandler } from '../../common/asyncHandler.js';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import { createDepartmentSchema, updateDepartmentSchema, idParamSchema } from './departments.schemas.js';
import * as service from './departments.service.js';

export const departmentsRouter = Router();

departmentsRouter.use(authenticate, requireRole('SUPER_ADMIN', 'EXAM_ADMIN'));

function parseId(raw: string | undefined): string {
  return idParamSchema.parse(raw ?? '');
}

departmentsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await service.listDepartments());
  }),
);

departmentsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createDepartmentSchema.parse(req.body);
    res.status(201).json({ department: await service.createDepartment(body, req.auth!.userId, req.ip ?? null) });
  }),
);

departmentsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = updateDepartmentSchema.parse(req.body);
    res.json({ department: await service.updateDepartment(parseId(req.params.id), body, req.auth!.userId, req.ip ?? null) });
  }),
);

departmentsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await service.deleteDepartment(parseId(req.params.id), req.auth!.userId, req.ip ?? null);
    res.json({ message: 'Department deleted' });
  }),
);
