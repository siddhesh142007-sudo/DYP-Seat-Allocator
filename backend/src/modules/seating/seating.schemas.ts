import { z } from 'zod';

export const generateSeatingSchema = z.object({
  mode: z.enum(['MIXED', 'BLOCK']).default('MIXED').optional(),
  seed: z.string().or(z.number()).optional(),
  roomIds: z.array(z.string().uuid()).optional(),
  historyDepth: z.number().int().min(0).max(5).default(3).optional(),
  timeBudgetMs: z.number().int().min(100).max(60000).default(5000).optional(),
});

export const regenerateSeatingSchema = generateSeatingSchema.extend({
  reason: z.string().min(3).optional(),
  confirm: z.boolean().default(false).optional(),
});

export const publishSchema = z.object({
  reason: z.string().min(3).optional(),
});

export const unpublishSchema = z.object({
  reason: z.string().min(5).max(500),
});
