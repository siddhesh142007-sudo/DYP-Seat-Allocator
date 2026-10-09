import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../common/asyncHandler.js';
import { ValidationError } from '../../common/errors.js';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import {
  createClassroomSchema,
  updateClassroomSchema,
  listClassroomsQuerySchema,
  generateSeatsSchema,
  updateSeatSchema,
  idParamSchema,
} from './classrooms.schemas.js';
import * as service from './classrooms.service.js';
import { buildTemplate, importClassrooms } from './import.service.js';

export const classroomsRouter = Router();

classroomsRouter.use(authenticate, requireRole('SUPER_ADMIN', 'EXAM_ADMIN'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
});

/** Maps multer errors (file too large, unexpected field…) to 400 responses. */
function handleUpload(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    const message =
      err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? 'File is larger than the 4 MB limit'
        : `Upload failed: ${err instanceof Error ? err.message : 'unknown error'}`;
    next(new ValidationError(message));
  });
}

function parseId(raw: string | undefined): string {
  return idParamSchema.parse(raw ?? '');
}

function isDryRun(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

classroomsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = listClassroomsQuerySchema.parse(req.query);
    res.json(await service.listClassrooms(query));
  }),
);

// Must precede GET /:id, otherwise "import" is parsed as an id.
classroomsRouter.get(
  '/import/template',
  asyncHandler(async (req, res) => {
    const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
    const template = await buildTemplate(format);
    res.setHeader('Content-Type', template.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${template.filename}"`);
    res.send(template.content);
  }),
);

classroomsRouter.post(
  '/import',
  handleUpload,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('A file field named "file" is required (.csv or .xlsx)');
    const dryRun = isDryRun(req.body?.dryRun);
    const report = await importClassrooms(
      req.file.originalname,
      req.file.buffer,
      dryRun,
      req.auth!.userId,
      req.ip ?? null,
    );
    res.json(report);
  }),
);

classroomsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ classroom: await service.getClassroom(parseId(req.params.id)) });
  }),
);

classroomsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createClassroomSchema.parse(req.body);
    res.status(201).json({ classroom: await service.createClassroom(body, req.auth!.userId, req.ip ?? null) });
  }),
);

classroomsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = updateClassroomSchema.parse(req.body);
    res.json({ classroom: await service.updateClassroom(parseId(req.params.id), body, req.auth!.userId, req.ip ?? null) });
  }),
);

classroomsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await service.deleteClassroom(parseId(req.params.id), req.auth!.userId, req.ip ?? null);
    res.json({ message: 'Classroom deleted' });
  }),
);

classroomsRouter.post(
  '/:id/generate-seats',
  asyncHandler(async (req, res) => {
    const body = generateSeatsSchema.parse(req.body);
    res.status(201).json({ classroom: await service.generateSeats(parseId(req.params.id), body, req.auth!.userId, req.ip ?? null) });
  }),
);

classroomsRouter.delete(
  '/:id/seats',
  asyncHandler(async (req, res) => {
    res.json({ classroom: await service.clearSeats(parseId(req.params.id), req.auth!.userId, req.ip ?? null) });
  }),
);

classroomsRouter.patch(
  '/:id/seats/:seatId',
  asyncHandler(async (req, res) => {
    const body = updateSeatSchema.parse(req.body);
    const seat = await service.updateSeat(parseId(req.params.id), parseId(req.params.seatId), body.status, req.auth!.userId, req.ip ?? null);
    res.json({ seat });
  }),
);
