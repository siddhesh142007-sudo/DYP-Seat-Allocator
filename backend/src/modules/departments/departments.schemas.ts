import { z } from 'zod';

const statusEnum = z.enum(['ACTIVE', 'INACTIVE']);

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(150),
  code: z.string().trim().min(1).max(50),
  status: statusEnum.optional(),
});

export const updateDepartmentSchema = createDepartmentSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field to update is required' });

export const idParamSchema = z.string().uuid();

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
