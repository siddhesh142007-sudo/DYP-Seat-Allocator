import { z } from 'zod';

const classroomStatusEnum = z.enum(['AVAILABLE', 'UNAVAILABLE']);
const seatStatusEnum = z.enum(['AVAILABLE', 'DISABLED']);

export const createClassroomSchema = z.object({
  roomNumber: z.string().trim().min(1).max(50),
  building: z.string().trim().min(1).max(100).nullable().optional(),
  floor: z.string().trim().min(1).max(20).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  status: classroomStatusEnum.optional(),
});

export const updateClassroomSchema = createClassroomSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field to update is required' });

export const listClassroomsQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: classroomStatusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const generateSeatsSchema = z
  .object({
    count: z.coerce.number().int().min(1).max(500),
    rows: z.coerce.number().int().min(1).max(50).optional(),
    cols: z.coerce.number().int().min(1).max(50).optional(),
  })
  .superRefine((data, ctx) => {
    if ((data.rows == null) !== (data.cols == null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rows'], message: 'Provide both rows and cols, or neither' });
    }
    if (data.rows != null && data.cols != null && data.rows * data.cols !== data.count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['count'],
        message: `count must equal rows × cols (${data.rows * data.cols}) when a layout is given`,
      });
    }
  });

export const updateSeatSchema = z.object({ status: seatStatusEnum });

export const idParamSchema = z.string().uuid();

export type CreateClassroomInput = z.infer<typeof createClassroomSchema>;
export type UpdateClassroomInput = z.infer<typeof updateClassroomSchema>;
export type ListClassroomsQuery = z.infer<typeof listClassroomsQuerySchema>;
export type GenerateSeatsInput = z.infer<typeof generateSeatsSchema>;
