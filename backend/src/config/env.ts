import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment schema. All input from the process environment is validated with
 * Zod; nothing is trusted blindly. Production requires real secrets.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(3001),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z
      .string()
      .min(1)
      .default('postgresql://seating:seating_dev_password@localhost:5432/exam_seating?schema=public'),

    JWT_SECRET: z.string().min(32).optional(),
    JWT_REFRESH_SECRET: z.string().min(32).optional(),
    ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(604800),
    REFRESH_COOKIE_NAME: z.string().min(1).default('rt'),
    PASSWORD_HASH_COST: z.coerce.number().int().min(12).default(12),

    CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
    VITE_API_URL: z.string().optional(),

    SEATING_TIME_BUDGET_MS: z.coerce.number().int().positive().default(10000),
    SEATING_DEFAULT_HISTORY_DEPTH: z.coerce.number().int().min(0).default(3),

    // Prisma's default interactive-transaction timeout is 5 s, which a remote
    // database can exceed (cold start, slow query), aborting with P2028.
    DB_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20000),

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

    SUPER_ADMIN_EMAIL: z.string().email().optional(),
    SUPER_ADMIN_PASSWORD: z.string().optional(),
    SUPER_ADMIN_NAME: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET is required in production (min 32 chars)',
      });
    }
    if (!env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET is required in production (min 32 chars)',
      });
    }
  });

const DEV_JWT_FALLBACK = 'dev_only_insecure_jwt_secret_do_not_use_in_production_000';
const DEV_JWT_REFRESH_FALLBACK = 'dev_only_insecure_refresh_secret_do_not_use_in_prod_00';

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  corsOrigins: raw.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
  jwtSecret: raw.JWT_SECRET ?? DEV_JWT_FALLBACK,
  jwtRefreshSecret: raw.JWT_REFRESH_SECRET ?? DEV_JWT_REFRESH_FALLBACK,
  usingDevSecrets: !raw.JWT_SECRET || !raw.JWT_REFRESH_SECRET,
} as const;

export type Env = typeof env;
