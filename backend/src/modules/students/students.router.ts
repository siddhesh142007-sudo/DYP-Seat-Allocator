import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../common/asyncHandler.js';
import { ValidationError } from '../../common/errors.js';
import { authenticate, requireRole } from '../auth/auth.middleware.js';
import { createStudentSchema, updateStudentSchema, listStudentsQuerySchema, idParamSchema } from './students.schemas.js';
import * as service from './students.service.js';
import { buildTemplate, importStudents } from './import.service.js';

export const studentsRouter = Router();

studentsRouter.use(authenticate, requireRole('SUPER_ADMIN', 'EXAM_ADMIN'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

/** Maps multer errors (file too large, unexpected field…) to 400 responses. */
function handleUpload(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    const message =
      err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? 'File is larger than the 5 MB limit'
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

studentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = listStudentsQuerySchema.parse(req.query);
    res.json(await service.listStudents(query));
  }),
);

studentsRouter.get(
  '/import/template',
  asyncHandler(async (req, res) => {
    const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
    const template = await buildTemplate(format);
    res.setHeader('Content-Type', template.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${template.filename}"`);
    res.send(template.content);
  }),
);

studentsRouter.post(
  '/import',
  handleUpload,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ValidationError('A file field named "file" is required (.csv or .xlsx)');
    const dryRun = isDryRun(req.body?.dryRun);
    const report = await importStudents(req.file.originalname, req.file.buffer, dryRun, req.auth!.userId, req.ip ?? null);
    res.json(report);
  }),
);

studentsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createStudentSchema.parse(req.body);
    res.status(201).json({ student: await service.createStudent(body, req.auth!.userId, req.ip ?? null) });
  }),
);

studentsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = updateStudentSchema.parse(req.body);
    res.json({ student: await service.updateStudent(parseId(req.params.id), body, req.auth!.userId, req.ip ?? null) });
  }),
);

studentsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await service.deactivateStudent(parseId(req.params.id), req.auth!.userId, req.ip ?? null);
    res.json({ message: 'Student deactivated' });
  }),
);
