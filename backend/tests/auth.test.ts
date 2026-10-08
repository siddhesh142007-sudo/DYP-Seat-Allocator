import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type pg from 'pg';
import { createTestPool, truncateAll } from './helpers/db.js';
import { createTestUser, createTestStudent, type TestUser } from './helpers/auth.js';
import { createApp } from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/db/prisma.js';

const PW = {
  super: 'SuperSecret123!',
  exam: 'ExamAdmin123!',
  student: 'Student123!',
  rateBad: 'WrongPassword123!',
} as const;

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let superAdmin: TestUser;
let examAdmin: TestUser;
let studentARow: { id: string; rollNumber: string };

beforeAll(async () => {
  pool = createTestPool(5);
  await truncateAll(pool);
  app = createApp();

  superAdmin = await createTestUser(pool, { role: 'SUPER_ADMIN', password: PW.super, email: 'sa@test.local' });
  examAdmin = await createTestUser(pool, { role: 'EXAM_ADMIN', password: PW.exam, email: 'ea@test.local' });
  studentARow = await createTestStudent(pool, { rollPrefix: 'AU' });
}, 60000);

afterAll(async () => {
  await pool.end();
  await disconnectPrisma();
});

function login(identifier: string, password: string) {
  return request(app).post('/api/v1/auth/login').send({ identifier, password });
}

/** Full `rt=...` cookie pair value from a set-cookie header. */
function refreshCookie(res: request.Response): string {
  const header = res.headers['set-cookie'];
  const first = Array.isArray(header) ? header[0] : header;
  if (!first) throw new Error('expected a set-cookie header');
  return first.split(';')[0] ?? '';
}

function cookieValue(pair: string): string {
  return pair.slice(pair.indexOf('=') + 1);
}

async function accessTokenFor(identifier: string, password: string): Promise<string> {
  const res = await login(identifier, password);
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

describe('POST /auth/login', () => {
  it('logs in an admin with email and returns a token plus httpOnly refresh cookie', async () => {
    const res = await login(superAdmin.email!, PW.super);
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.expiresIn).toBe(900);
    expect(res.body.user).toMatchObject({ id: superAdmin.id, role: 'SUPER_ADMIN', email: 'sa@test.local' });
    expect(res.body.user.passwordHash).toBeUndefined();

    const header = res.headers['set-cookie'];
    const first = Array.isArray(header) ? header[0] : header;
    expect(first).toBeDefined();
    expect(first).toContain('rt=');
    expect(first).toContain('HttpOnly');
    expect(first).toContain('SameSite=Lax');
    expect(first).toContain('Path=/api/v1/auth');
  });

  it('refuses a roll number as a login identifier (admin-only system)', async () => {
    const res = await login(studentARow.rollNumber, PW.student);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a wrong password with a generic message', async () => {
    const res = await login(superAdmin.email!, PW.rateBad);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Invalid email or password');
  });

  it('returns the identical message for unknown users (no user enumeration)', async () => {
    const wrongPassword = await login(superAdmin.email!, PW.rateBad);
    const unknownUser = await login('definitely-not-a-user@test.local', PW.rateBad);
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(unknownUser.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it('rejects inactive accounts with the same generic message', async () => {
    const inactive = await createTestUser(pool, {
      role: 'EXAM_ADMIN',
      password: PW.exam,
      email: 'inactive@test.local',
      status: 'INACTIVE',
    });
    const res = await login(inactive.email!, PW.exam);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid email or password');
  });

  it('validates the payload with Zod', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.some((d: { path: string }) => d.path === 'identifier')).toBe(true);
    expect(res.body.error.details.some((d: { path: string }) => d.path === 'password')).toBe(true);
  });
});

describe('protected routes', () => {
  it('returns 401 for /auth/me without a token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns the current user (never the hash) for a valid token', async () => {
    const token = await accessTokenFor(superAdmin.email!, PW.super);
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: superAdmin.id, role: 'SUPER_ADMIN' });
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('rejects a garbage token', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer not.a.token');
    expect(res.status).toBe(401);
  });

  it('returns 401 for an admin route without a token', async () => {
    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(401);
  });

  it('rejects a tampered access token with 401', async () => {
    const token = await accessTokenFor(superAdmin.email!, PW.super);
    const res = await request(app)
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${token.slice(0, -3)}xyz`);
    expect(res.status).toBe(401);
  });

  it('returns 403 when an EXAM_ADMIN calls a SUPER_ADMIN-only route', async () => {
    const token = await accessTokenFor(examAdmin.email!, PW.exam);
    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('allows a SUPER_ADMIN on admin routes', async () => {
    const token = await accessTokenFor(superAdmin.email!, PW.super);
    const res = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    const first = res.body.items[0];
    if (first) expect(first.passwordHash).toBeUndefined();
  });
});

describe('POST /auth/refresh (rotation)', () => {
  it('rotates the refresh cookie and issues a fresh access token', async () => {
    const loginRes = await login(superAdmin.email!, PW.super);
    const cookie1 = refreshCookie(loginRes);

    const refreshRes = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie1);
    expect(refreshRes.status).toBe(200);
    const cookie2 = refreshCookie(refreshRes);
    expect(cookieValue(cookie2)).not.toBe(cookieValue(cookie1));
    expect(refreshRes.body.accessToken).not.toBe(loginRes.body.accessToken);

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${refreshRes.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(superAdmin.id);
  });

  it('rejects a refresh without a cookie', async () => {
    const res = await request(app).post('/api/v1/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a tampered refresh token', async () => {
    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', 'rt=tampered.token.value');
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the refresh token so it can no longer be used', async () => {
    const loginRes = await login(examAdmin.email!, PW.exam);
    const cookie1 = refreshCookie(loginRes);

    const logoutRes = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie1);
    expect(logoutRes.status).toBe(200);
    const clearedHeader = logoutRes.headers['set-cookie'];
    const cleared = Array.isArray(clearedHeader) ? clearedHeader[0] : clearedHeader;
    expect(cleared).toContain('rt=;');

    const reuse = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie1);
    expect(reuse.status).toBe(401);
  });

  it('is idempotent without a cookie', async () => {
    const res = await request(app).post('/api/v1/auth/logout');
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/change-password', () => {
  it('rejects a wrong current password', async () => {
    const user = await createTestUser(pool, { role: 'EXAM_ADMIN', password: 'OldPass12345', email: 'cp@test.local' });
    const token = await accessTokenFor(user.email!, 'OldPass12345');
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'NotThePassword1', newPassword: 'NewPass12345' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Current password is incorrect');
  });

  it('changes the password, revokes sessions, and enforces the new password', async () => {
    const user = await createTestUser(pool, { role: 'EXAM_ADMIN', password: 'OldPass12345', email: 'cp2@test.local' });
    const loginRes = await login(user.email!, 'OldPass12345');
    const oldCookie = refreshCookie(loginRes);

    const changeRes = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
      .send({ currentPassword: 'OldPass12345', newPassword: 'NewPass12345' });
    expect(changeRes.status).toBe(200);

    // Old refresh session is revoked by the token-version bump.
    const reuse = await request(app).post('/api/v1/auth/refresh').set('Cookie', oldCookie);
    expect(reuse.status).toBe(401);

    // Old password no longer works; new one does.
    const oldLogin = await login(user.email!, 'OldPass12345');
    expect(oldLogin.status).toBe(401);
    const newLogin = await login(user.email!, 'NewPass12345');
    expect(newLogin.status).toBe(200);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'whatever123', newPassword: 'whatever456' });
    expect(res.status).toBe(401);
  });
});

describe('login rate limiting', () => {
  it('returns 429 after repeated failed logins for the same identifier', async () => {
    const identifier = `ratelimit_${Date.now()}@test.local`;
    for (let i = 0; i < 10; i++) {
      const attempt = await login(identifier, PW.rateBad);
      expect(attempt.status).toBe(401);
    }
    const blocked = await login(identifier, PW.rateBad);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  }, 60000);

  it('does not lock out other identifiers', async () => {
    const other = await login(superAdmin.email!, PW.super);
    expect(other.status).toBe(200);
  });
});

describe('audit logging', () => {
  it('records login success and failure without ever storing the password', async () => {
    await login(superAdmin.email!, PW.super);
    await login(superAdmin.email!, PW.rateBad);

    const rows = await prisma.auditLog.findMany({
      where: { action: { in: ['auth.login', 'auth.login_failed'] } },
    });
    expect(rows.some((r) => r.action === 'auth.login')).toBe(true);
    expect(rows.some((r) => r.action === 'auth.login_failed')).toBe(true);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(PW.super);
    expect(serialized).not.toContain(PW.rateBad);
  });
});

describe('users management (SUPER_ADMIN only)', () => {
  it('creates, lists, updates and deletes users without exposing hashes', async () => {
    const token = await accessTokenFor(superAdmin.email!, PW.super);

    const created = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Admin', email: 'newadmin@test.local', password: 'BrandNew123!', role: 'EXAM_ADMIN' });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ name: 'New Admin', role: 'EXAM_ADMIN' });
    expect(created.body.user.passwordHash).toBeUndefined();
    const newId = created.body.user.id as string;

    const duplicate = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Dup', email: 'NEWADMIN@test.local', password: 'BrandNew123!', role: 'EXAM_ADMIN' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');

    const retiredRole = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Student Account', email: 'st@test.local', password: 'BrandNew123!', role: 'STUDENT' });
    expect(retiredRole.status).toBe(400);
    expect(retiredRole.body.error.code).toBe('VALIDATION_ERROR');

    const updated = await request(app)
      .put(`/api/v1/users/${newId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed Admin' });
    expect(updated.status).toBe(200);
    expect(updated.body.user.name).toBe('Renamed Admin');

    const listed = await request(app)
      .get('/api/v1/users?search=Renamed')
      .set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.items.some((u: { id: string }) => u.id === newId)).toBe(true);
    expect(listed.body.items[0]?.passwordHash).toBeUndefined();

    const deleted = await request(app).delete(`/api/v1/users/${newId}`).set('Authorization', `Bearer ${token}`);
    expect(deleted.status).toBe(200);
    const gone = await request(app).delete(`/api/v1/users/${newId}`).set('Authorization', `Bearer ${token}`);
    expect(gone.status).toBe(404);
  });

  it('refuses self role/status changes and self deletion', async () => {
    const token = await accessTokenFor(superAdmin.email!, PW.super);

    const selfRole = await request(app)
      .put(`/api/v1/users/${superAdmin.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'EXAM_ADMIN' });
    expect(selfRole.status).toBe(403);

    const selfDelete = await request(app).delete(`/api/v1/users/${superAdmin.id}`).set('Authorization', `Bearer ${token}`);
    expect(selfDelete.status).toBe(403);
    expect(selfDelete.body.error.message).toContain('your own account');
  });

  it('exposes the audit trail to SUPER_ADMIN only', async () => {
    const token = await accessTokenFor(superAdmin.email!, PW.super);
    const res = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items[0]).toHaveProperty('action');
    expect(res.body.items[0]).toHaveProperty('createdAt');

    const examAdminToken = await accessTokenFor(examAdmin.email!, PW.exam);
    const forbidden = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${examAdminToken}`);
    expect(forbidden.status).toBe(403);
  });
});

