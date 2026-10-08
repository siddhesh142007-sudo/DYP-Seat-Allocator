import { z } from 'zod';
import { YEAR_CODES } from '../dypit/roll.js';

/**
 * Division is an uppercase A-Z label supplied by the administrator.
 * Normalising here means an admin typing "c" gets "C" rather than a rejection.
 */
export const divisionSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{1,2}$/, 'Division must be A-Z (e.g. A, B, C)')
  .describe('Division label, A-Z');

export const yearCodeSchema = z.enum(YEAR_CODES);

/** Branch code must fit inside the roll grammar [A-Z]{2,6}. */
export const branchCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2,6}$/, 'Branch code must be 2-6 letters (e.g. AIDS, CE)');

const serialSchema = z.coerce.number().int().min(1).max(9999);

export const createIntentSchema = z
  .object({
    classroomId: z.string().uuid(),
    yearCode: yearCodeSchema,
    branchCode: branchCodeSchema,
    division: divisionSchema,
    fromSerial: serialSchema,
    toSerial: serialSchema,
    /** Bench grid; both or neither (mirrors the DB CHECK). */
    rowCount: z.coerce.number().int().min(1).max(50).nullable().optional(),
    colCount: z.coerce.number().int().min(1).max(50).nullable().optional(),
    /**
     * First bench to use, so several blocks can share one room. Omit it and the
     * service places the block in the next free bench window automatically.
     */
    seatOffset: z.coerce.number().int().min(1).max(1000).optional(),
    strictRollOrder: z.boolean().optional().default(false),
  })
  .superRefine((data, ctx) => {
    if (data.toSerial < data.fromSerial) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toSerial'],
        message: `toSerial (${data.toSerial}) must be >= fromSerial (${data.fromSerial})`,
      });
    }
    if ((data.rowCount == null) !== (data.colCount == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rowCount'],
        message: 'Provide both rowCount and colCount, or neither',
      });
    }
  });

export const updateIntentSchema = z
  .object({
    classroomId: z.string().uuid().optional(),
    fromSerial: serialSchema.optional(),
    toSerial: serialSchema.optional(),
    rowCount: z.coerce.number().int().min(1).max(50).nullable().optional(),
    colCount: z.coerce.number().int().min(1).max(50).nullable().optional(),
    seatOffset: z.coerce.number().int().min(1).max(1000).optional(),
    strictRollOrder: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'At least one field to update is required' });

/** Filters for listing intents / looking up students in a cohort. */
export const cohortQuerySchema = z.object({
  yearCode: yearCodeSchema.optional(),
  branchCode: branchCodeSchema.optional(),
  division: divisionSchema.optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

/** Preview of which students a roll range resolves to. */
export const previewRangeSchema = z
  .object({
    yearCode: yearCodeSchema,
    branchCode: branchCodeSchema,
    division: divisionSchema,
    fromSerial: serialSchema,
    toSerial: serialSchema,
  })
  .superRefine((data, ctx) => {
    if (data.toSerial < data.fromSerial) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toSerial'],
        message: `toSerial (${data.toSerial}) must be >= fromSerial (${data.fromSerial})`,
      });
    }
  });

export const intentParamSchema = z.object({
  examId: z.string().uuid(),
  intentId: z.string().uuid(),
});

export type CreateIntentInput = z.infer<typeof createIntentSchema>;
export type UpdateIntentInput = z.infer<typeof updateIntentSchema>;
export type CohortQuery = z.infer<typeof cohortQuerySchema>;
export type PreviewRangeInput = z.infer<typeof previewRangeSchema>;