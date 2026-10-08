import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closeDb } from '../src/db/pool.js';

const app = createApp();

afterAll(async () => {
  await closeDb();
});

describe('error format', () => {
  it('returns 404 with the standard error envelope for unknown routes', async () => {
    const res = await request(app).get('/api/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: expect.stringContaining('Route not found'),
        details: null,
      },
    });
  });

  it('returns 400 INVALID_JSON for malformed JSON bodies', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{ this is not json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
    expect(typeof res.body.error.message).toBe('string');
    expect('details' in res.body.error).toBe(true);
  });

  it('returns 413 PAYLOAD_TOO_LARGE when the body exceeds the limit', async () => {
    const big = JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) });
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(big);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
