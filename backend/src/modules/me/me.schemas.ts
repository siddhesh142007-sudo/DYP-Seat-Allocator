import { z } from 'zod';

/** Route params for the student's own seating slip. */
export const slipParamsSchema = z.object({
  examId: z.string().uuid('examId must be a UUID'),
});
