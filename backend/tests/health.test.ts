import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closeDb } from '../src/db/pool.js';

const app = createApp();

afterAll(async () => {
  await closeDb();
});

describe('GET /api/v1/health', () => {
  it('returns health status with database state', async () => {
    const res = await request(app).get('/api/v1/health');
    // 200 when the DB is reachable, 503 (degraded) when it is not.
    expect([200, 503]).toContain(res.status);
    expect(['ok', 'degraded']).toContain(res.body.status);
    expect(['up', 'down']).toContain(res.body.db);
    expect(typeof res.body.dbLatencyMs).toBe('number');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('echoes a provided X-Request-Id and generates one otherwise', async () => {
    const withId = await request(app)
      .get('/api/v1/health')
      .set('X-Request-Id', 'test-req-id-123');
    expect(withId.headers['x-request-id']).toBe('test-req-id-123');

    const withoutId = await request(app).get('/api/v1/health');
    expect(withoutId.headers['x-request-id']).toBeTruthy();
  });
});
