import { z } from 'zod';

const roleEnum = z.enum(['SUPER_ADMIN', 'EXAM_ADMIN']);
const statusEnum = z.enum(['ACTIVE', 'INACTIVE']);

export const createUserSchema = z.object({
  name: z.string().trim().min(1).max(255),
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  role: roleEnum,
  status: statusEnum.optional(),
});

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    email: z.string().trim().toLowerCase().email().max(255).nullable().optional(),
    role: roleEnum.optional(),
    status: statusEnum.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field to update is required' });

export const listUsersQuerySchema = z.object({
  role: roleEnum.optional(),
  status: statusEnum.optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const idParamSchema = z.string().uuid();

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
