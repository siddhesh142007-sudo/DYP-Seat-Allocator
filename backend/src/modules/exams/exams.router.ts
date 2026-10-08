import { Router } from 'express';
import { asyncHandler } from '../../common/asyncHandler.js';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import {
  addRegistrationSchema,
  createExamSchema,
  idParamSchema,
  listEligibleQuerySchema,
  listExamsQuerySchema,
  listRegistrationsQuerySchema,
  updateExamSchema,
  updateRegistrationSchema,
} from './exams.schemas.js';
import * as service from './exams.service.js';

export const examsRouter = Router();

examsRouter.use(authenticate, requireRole('SUPER_ADMIN', 'EXAM_ADMIN'));

function parseId(raw: string | undefined): string {
  return idParamSchema.parse(raw ?? '');
}

examsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = listExamsQuerySchema.parse(req.query);
    res.json(await service.listExams(query));
  }),
);

examsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createExamSchema.parse(req.body);
    res.status(201).json(await service.createExam(body, req.auth!.userId, req.ip ?? null));
  }),
);

examsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await service.getExam(parseId(req.params.id)));
  }),
);

examsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = updateExamSchema.parse(req.body);
    res.json(await service.updateExam(parseId(req.params.id), body, req.auth!.userId, req.ip ?? null));
  }),
);

examsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await service.deleteExam(parseId(req.params.id), req.auth!.userId, req.ip ?? null));
  }),
);

examsRouter.get(
  '/:id/registrations',
  asyncHandler(async (req, res) => {
    const query = listRegistrationsQuerySchema.parse(req.query);
    res.json(await service.listRegistrations(parseId(req.params.id), query));
  }),
);

examsRouter.post(
  '/:id/registrations',
  asyncHandler(async (req, res) => {
    const body = addRegistrationSchema.parse(req.body);
    res.status(201).json(await service.addRegistration(parseId(req.params.id), body.studentId, req.auth!.userId, req.ip ?? null));
  }),
);

examsRouter.patch(
  '/:id/registrations/:studentId',
  asyncHandler(async (req, res) => {
    const body = updateRegistrationSchema.parse(req.body);
    res.json(
      await service.setRegistrationStatus(
        parseId(req.params.id),
        parseId(req.params.studentId),
        body.status,
        req.auth!.userId,
        req.ip ?? null,
      ),
    );
  }),
);

examsRouter.get(
  '/:id/eligible-students',
  asyncHandler(async (req, res) => {
    const query = listEligibleQuerySchema.parse(req.query);
    res.json(await service.listEligibleStudents(parseId(req.params.id), query));
  }),
);

examsRouter.get(
  '/:id/seating-preview-stats',
  asyncHandler(async (req, res) => {
    res.json(await service.seatingPreviewStats(parseId(req.params.id)));
  }),
);
