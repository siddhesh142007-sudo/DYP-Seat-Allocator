import { z } from 'zod';

export const examIdParamSchema = z.object({
  examId: z.string().uuid('examId must be a UUID'),
});

const includeDraft = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const classroomExportQuerySchema = z.object({
  format: z.enum(['pdf', 'csv', 'xlsx']).default('pdf'),
  includeDraft,
});

export const departmentExportQuerySchema = z.object({
  format: z.enum(['pdf', 'csv', 'xlsx']).default('pdf'),
  includeDraft,
});

export const studentExportQuerySchema = z.object({
  format: z.enum(['pdf', 'csv', 'xlsx']).default('pdf'),
  includeDraft,
});

/** The complete plan renders as PDF (cover + pages) or XLSX (sheets), not CSV. */
export const planExportQuerySchema = z.object({
  format: z.enum(['pdf', 'xlsx']).default('pdf'),
  includeDraft,
});

export const slipExportQuerySchema = z.object({
  studentId: z.string().uuid('studentId must be a UUID'),
  includeDraft,
});

export const slipsExportQuerySchema = z.object({
  includeDraft,
});
