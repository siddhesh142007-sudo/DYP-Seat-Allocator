import { z } from 'zod';

const statusEnum = z.enum(['ACTIVE', 'INACTIVE']);

export const createAcademicYearSchema = z.object({
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(20).optional(),
  orderIndex: z.number().int().min(0).max(10_000).optional(),
  status: statusEnum.optional(),
});

export const updateAcademicYearSchema = createAcademicYearSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field to update is required' });

export const idParamSchema = z.string().uuid();

export type CreateAcademicYearInput = z.infer<typeof createAcademicYearSchema>;
export type UpdateAcademicYearInput = z.infer<typeof updateAcademicYearSchema>;
