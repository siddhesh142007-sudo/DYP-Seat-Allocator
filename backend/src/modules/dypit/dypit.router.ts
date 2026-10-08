import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/asyncHandler.js';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import {
  createIntentSchema,
  updateIntentSchema,
  cohortQuerySchema,
  previewRangeSchema,
} from './intents.schemas.js';
import * as service from './intents.service.js';
import * as generationService from './generation.service.js';

export const dypitRouter = Router();

// DYPIT is an administrator-only system: no student-facing routes live here.
dypitRouter.use(authenticate, requireRole('SUPER_ADMIN', 'EXAM_ADMIN'));

/** Distinct year/branch/division cohorts, for populating the builder UI. */
dypitRouter.get(
  '/cohorts',
  asyncHandler(async (req, res) => {
    const cohorts = await service.listCohorts();
    res.json({ cohorts });
  }),
);

/** Students a roll range resolves to, for previewing before creating an intent. */
dypitRouter.post(
  '/preview-range',
  asyncHandler(async (req, res) => {
    const range = previewRangeSchema.parse(req.body);
    res.json(await service.previewRange(range));
  }),
);

/** Students of a cohort, paginated (used by the builder's student list). */
dypitRouter.get(
  '/students',
  asyncHandler(async (req, res) => {
    const query = cohortQuerySchema.parse(req.query);
    res.json(await service.listCohortStudents(query));
  }),
);

/** Allocation intents for one exam. */
dypitRouter.get(
  '/exams/:examId/intents',
  asyncHandler(async (req, res) => {
    const examId = z.string().uuid().parse(req.params.examId);
    const intents = await service.listIntents(examId);
    res.json({ intents });
  }),
);

dypitRouter.post(
  '/exams/:examId/intents',
  asyncHandler(async (req, res) => {
    const examId = z.string().uuid().parse(req.params.examId);
    const input = createIntentSchema.parse(req.body);
    const intent = await service.createIntent(examId, input, {
      actorUserId: req.auth?.userId ?? null,
      ip: req.ip ?? null,
    });
    res.status(201).json({ intent });
  }),
);

dypitRouter.patch(
  '/exams/:examId/intents/:intentId',
  asyncHandler(async (req, res) => {
    const examId = z.string().uuid().parse(req.params.examId);
    const intentId = z.string().uuid().parse(req.params.intentId);
    const input = updateIntentSchema.parse(req.body);
    const intent = await service.updateIntent(examId, intentId, input, {
      actorUserId: req.auth?.userId ?? null,
      ip: req.ip ?? null,
    });
    res.json({ intent });
  }),
);

dypitRouter.delete(
  '/exams/:examId/intents/:intentId',
  asyncHandler(async (req, res) => {
    const examId = z.string().uuid().parse(req.params.examId);
    const intentId = z.string().uuid().parse(req.params.intentId);
    await service.deleteIntent(examId, intentId, {
      actorUserId: req.auth?.userId ?? null,
      ip: req.ip ?? null,
    });
    res.status(204).end();
  }),
);

/** Full plan preview: which students land in which room/bench, before generating. */
dypitRouter.get(
  '/exams/:examId/intents/plan',
  asyncHandler(async (req, res) => {
    const examId = z.string().uuid().parse(req.params.examId);
    res.json(await service.previewPlan(examId));
  }),
);
const generateSchema = z.object({
  seed: z.string().trim().max(64).optional(),
  historyDepth: z.coerce.number().int().min(0).max(10).optional(),
  replace: z.boolean().optional().default(false),
});

/**
 * Generates the plan by executing this exam's intents, rather than searching
 * the whole building. See generation.service.ts.
 */
dypitRouter.post(
  '/exams/:examId/generate-from-intents',
  asyncHandler(async (req, res) => {
    const examId = z.string().uuid().parse(req.params.examId);
    const options = generateSchema.parse(req.body ?? {});
    const result = await generationService.generateFromIntents(examId, options, {
      actorUserId: req.auth?.userId ?? null,
      ip: req.ip ?? null,
    });
    res.json({ result });
  }),
);

/** Read-only explanation of what the current intents would seat. */
dypitRouter.get(
  '/exams/:examId/intents/explain',
  asyncHandler(async (req, res) => {
    const examId = z.string().uuid().parse(req.params.examId);
    res.json(await generationService.explainIntents(examId));
  }),
);
