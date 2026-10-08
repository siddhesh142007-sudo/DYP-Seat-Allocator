import { Router, type Request, type Response } from 'express';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import { asyncHandler } from '../../common/asyncHandler.js';
import type { ExportFile } from './exports.model.js';
import * as service from './exports.service.js';
import {
  classroomExportQuerySchema,
  departmentExportQuerySchema,
  examIdParamSchema,
  planExportQuerySchema,
  slipExportQuerySchema,
  slipsExportQuerySchema,
  studentExportQuerySchema,
} from './exports.schemas.js';

export const exportsRouter = Router();

exportsRouter.use(authenticate);
exportsRouter.use(requireRole('EXAM_ADMIN', 'SUPER_ADMIN'));

function sendFile(res: Response, out: ExportFile): void {
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Content-Length', String(out.content.byteLength));
  res.end(out.content);
}

function requestContext(req: Request): service.ExportRequest {
  return {
    examId: '',
    includeDraft: false,
    actorId: req.auth!.userId,
    ip: req.ip ?? null,
  };
}

exportsRouter.get(
  '/exams/:examId/classroom',
  asyncHandler(async (req: Request, res: Response) => {
    const { examId } = examIdParamSchema.parse(req.params);
    const query = classroomExportQuerySchema.parse(req.query);
    sendFile(res, await service.exportClassroomWise({ ...requestContext(req), examId, includeDraft: query.includeDraft }, query.format));
  }),
);

exportsRouter.get(
  '/exams/:examId/department',
  asyncHandler(async (req: Request, res: Response) => {
    const { examId } = examIdParamSchema.parse(req.params);
    const query = departmentExportQuerySchema.parse(req.query);
    sendFile(res, await service.exportDepartmentWise({ ...requestContext(req), examId, includeDraft: query.includeDraft }, query.format));
  }),
);

exportsRouter.get(
  '/exams/:examId/students',
  asyncHandler(async (req: Request, res: Response) => {
    const { examId } = examIdParamSchema.parse(req.params);
    const query = studentExportQuerySchema.parse(req.query);
    sendFile(res, await service.exportStudentWise({ ...requestContext(req), examId, includeDraft: query.includeDraft }, query.format));
  }),
);

exportsRouter.get(
  '/exams/:examId/plan',
  asyncHandler(async (req: Request, res: Response) => {
    const { examId } = examIdParamSchema.parse(req.params);
    const query = planExportQuerySchema.parse(req.query);
    sendFile(res, await service.exportFullPlan({ ...requestContext(req), examId, includeDraft: query.includeDraft }, query.format));
  }),
);

exportsRouter.get(
  '/exams/:examId/slip',
  asyncHandler(async (req: Request, res: Response) => {
    const { examId } = examIdParamSchema.parse(req.params);
    const query = slipExportQuerySchema.parse(req.query);
    sendFile(
      res,
      await service.exportSlip({ ...requestContext(req), examId, includeDraft: query.includeDraft }, query.studentId),
    );
  }),
);

exportsRouter.get(
  '/exams/:examId/slips',
  asyncHandler(async (req: Request, res: Response) => {
    const { examId } = examIdParamSchema.parse(req.params);
    const query = slipsExportQuerySchema.parse(req.query);
    sendFile(res, await service.exportBulkSlips({ ...requestContext(req), examId, includeDraft: query.includeDraft }));
  }),
);
