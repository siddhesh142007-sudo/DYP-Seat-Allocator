import { z } from 'zod';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** 'HH:mm' or 'HH:mm:ss' accepted; normalised to 'HH:mm'. */
export const timeStringSchema = z
  .string()
  .trim()
  .regex(timeRegex, 'Time must be in HH:mm format')
  .transform((v) => v.slice(0, 5));

export const dateStringSchema = z
  .string()
  .trim()
  .regex(dateRegex, 'Date must be in YYYY-MM-DD format');

const examStatusEnum = z.enum(['PLANNED', 'COMPLETED', 'CANCELLED']);
export const registrationStatusEnum = z.enum(['REGISTERED', 'ABSENT', 'WITHHELD', 'REMOVED']);

export function timeToMinutes(hhmm: string): number {
  const match = timeRegex.exec(hhmm);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

export const createExamSchema = z
  .object({
    subject: z.string().trim().min(1).max(255),
    paperCode: z.string().trim().max(50).nullable().optional(),
    examDate: dateStringSchema,
    startTime: timeStringSchema,
    endTime: timeStringSchema,
    semester: z.number().int().min(1).max(16).nullable().optional(),
    academicYearId: z.string().uuid(),
    status: examStatusEnum.optional(),
    /** Auto-register every ACTIVE student of the academic year (default on). */
    autoRegister: z.boolean().optional().default(true),
  })
  .refine((d) => timeToMinutes(d.endTime) > timeToMinutes(d.startTime), {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

export const updateExamSchema = z
  .object({
    subject: z.string().trim().min(1).max(255).optional(),
    paperCode: z.string().trim().max(50).nullable().optional(),
    examDate: dateStringSchema.optional(),
    startTime: timeStringSchema.optional(),
    endTime: timeStringSchema.optional(),
    semester: z.number().int().min(1).max(16).nullable().optional(),
    academicYearId: z.string().uuid().optional(),
    status: examStatusEnum.optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'At least one field to update is required' });

const listSortEnum = z.enum(['subject', 'examDate', 'status', 'createdAt', 'updatedAt']);

export const listExamsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: examStatusEnum.optional(),
  academicYearId: z.string().uuid().optional(),
  dateFrom: dateStringSchema.optional(),
  dateTo: dateStringSchema.optional(),
  sort: listSortEnum.default('examDate'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const studentFilterSort = z.enum(['name', 'rollNumber', 'registeredAt', 'status']);

export const listRegistrationsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: registrationStatusEnum.optional(),
  departmentId: z.string().uuid().optional(),
  division: z.string().trim().max(50).optional(),
  sort: studentFilterSort.default('rollNumber'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const listEligibleQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  departmentId: z.string().uuid().optional(),
  division: z.string().trim().max(50).optional(),
  sort: z.enum(['name', 'rollNumber']).default('rollNumber'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const updateRegistrationSchema = z.object({
  status: registrationStatusEnum,
});

export const addRegistrationSchema = z.object({
  studentId: z.string().uuid(),
});

export const idParamSchema = z.string().uuid();

export type CreateExamInput = z.infer<typeof createExamSchema>;
export type UpdateExamInput = z.infer<typeof updateExamSchema>;
export type ListExamsQuery = z.infer<typeof listExamsQuerySchema>;
export type ListRegistrationsQuery = z.infer<typeof listRegistrationsQuerySchema>;
export type ListEligibleQuery = z.infer<typeof listEligibleQuerySchema>;
export type RegistrationStatusInput = z.infer<typeof registrationStatusEnum>;
