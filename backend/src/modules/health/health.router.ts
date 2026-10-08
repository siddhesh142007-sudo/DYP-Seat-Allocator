import { Router } from 'express';
import { checkDb } from '../../db/pool.js';
import { env } from '../../config/env.js';

export const healthRouter = Router();

const startedAt = Date.now();

healthRouter.get('/', async (_req, res) => {
  const db = await checkDb();
  const up = db.up;
  res.status(up ? 200 : 503).json({
    status: up ? 'ok' : 'degraded',
    db: up ? 'up' : 'down',
    dbLatencyMs: db.latencyMs,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    env: env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});
