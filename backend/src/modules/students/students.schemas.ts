import { z } from 'zod';

const statusEnum = z.enum(['ACTIVE', 'INACTIVE']);
const sortEnum = z.enum(['name', 'rollNumber', 'createdAt', 'updatedAt']);
const orderEnum = z.enum(['asc', 'desc']);

export const createStudentSchema = z.object({
  rollNumber: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(255),
  email: z.string().trim().toLowerCase().email().max(255).nullable().optional(),
  division: z.string().trim().min(1).max(50).nullable().optional(),
  status: statusEnum.optional(),
  academicYearId: z.string().uuid(),
  departmentId: z.string().uuid(),
  /** Also create a STUDENT login user; it must rotate the password on first login. */
  createLogin: z.boolean().optional().default(false),
  /** Password for the created login; defaults to the Welcome@<ROLL> policy. */
  password: z.string().min(8).max(128).optional(),
});

export const updateStudentSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    email: z.string().trim().toLowerCase().email().max(255).nullable().optional(),
    division: z.string().trim().min(1).max(50).nullable().optional(),
    status: statusEnum.optional(),
    academicYearId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    /** Add a login to an existing student that has none. */
    createLogin: z.boolean().optional(),
    password: z.string().min(8).max(128).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field to update is required' });

export const listStudentsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  academicYearId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  division: z.string().trim().max(50).optional(),
  status: statusEnum.optional(),
  sort: sortEnum.default('createdAt'),
  order: orderEnum.default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const idParamSchema = z.string().uuid();

export type CreateStudentInput = z.infer<typeof createStudentSchema>;
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;
export type ListStudentsQuery = z.infer<typeof listStudentsQuerySchema>;
