import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type pg from 'pg';
import { createTestPool, truncateAll } from './helpers/db.js';
import { createTestUser, createTestStudent, type TestUser } from './helpers/auth.js';
import { createApp } from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/db/prisma.js';

const PW = 'AdminSecret123!';

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let superAdmin: TestUser;
let examAdmin: TestUser;
let superToken: string;
let examToken: string;

beforeAll(async () => {
  pool = createTestPool(5);
  await truncateAll(pool);
  app = createApp();
  superAdmin = await createTestUser(pool, { role: 'SUPER_ADMIN', password: PW, email: 'sa-year@test.local' });
  examAdmin = await createTestUser(pool, { role: 'EXAM_ADMIN', password: PW, email: 'ea-year@test.local' });
  superToken = (await request(app).post('/api/v1/auth/login').send({ identifier: superAdmin.email, password: PW })).body
    .accessToken;
  examToken = (await request(app).post('/api/v1/auth/login').send({ identifier: examAdmin.email, password: PW })).body
    .accessToken;
}, 60000);

afterAll(async () => {
  await pool.end();
  await disconnectPrisma();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('academic years', () => {
  let yearId: string;

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/v1/academic-years');
    expect(res.status).toBe(401);
  });

  it('rejects anonymous requests with 401', async () => {
    const res = await request(app).get('/api/v1/academic-years');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('allows EXAM_ADMIN to list and create', async () => {
    const list = await request(app).get('/api/v1/academic-years').set(auth(examToken));
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);

    const created = await request(app)
      .post('/api/v1/academic-years')
      .set(auth(examToken))
      .send({ name: 'AY 2026-27', code: 'AY2627', orderIndex: 1 });
    expect(created.status).toBe(201);
    expect(created.body.academicYear).toMatchObject({ name: 'AY 2026-27', code: 'AY2627', status: 'ACTIVE' });
    yearId = created.body.academicYear.id;
  });

  it('rejects duplicate names with 409', async () => {
    const res = await request(app)
      .post('/api/v1/academic-years')
      .set(auth(superToken))
      .send({ name: 'AY 2026-27' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('validates the payload with Zod (400)', async () => {
    const res = await request(app).post('/api/v1/academic-years').set(auth(superToken)).send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('updates a year and writes an audit row', async () => {
    const res = await request(app)
      .put(`/api/v1/academic-years/${yearId}`)
      .set(auth(superToken))
      .send({ status: 'INACTIVE' });
    expect(res.status).toBe(200);
    expect(res.body.academicYear.status).toBe('INACTIVE');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'academic_year.update', entityId: yearId } });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(superAdmin.id);
  });

  it('refuses to delete a year referenced by students (409)', async () => {
    const student = await createTestStudent(pool, { rollPrefix: 'REF' });
    const studentRow = await prisma.student.findUnique({ where: { id: student.id } });
    const res = await request(app)
      .delete(`/api/v1/academic-years/${studentRow!.academicYearId}`)
      .set(auth(superToken));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Deactivate it instead');
  });

  it('deletes an unreferenced year', async () => {
    const created = await request(app)
      .post('/api/v1/academic-years')
      .set(auth(superToken))
      .send({ name: 'AY Temp', code: 'AYTMP' });
    const res = await request(app)
      .delete(`/api/v1/academic-years/${created.body.academicYear.id}`)
      .set(auth(superToken));
    expect(res.status).toBe(200);
  });
});

describe('departments', () => {
  let deptId: string;

  it('allows creation by SUPER_ADMIN', async () => {
    const res = await request(app)
      .post('/api/v1/departments')
      .set(auth(superToken))
      .send({ name: 'Computer Engineering', code: 'COMP' });
    expect(res.status).toBe(201);
    expect(res.body.department).toMatchObject({ code: 'COMP' });
    deptId = res.body.department.id;
  });

  it('rejects duplicate codes with 409', async () => {
    const res = await request(app)
      .post('/api/v1/departments')
      .set(auth(superToken))
      .send({ name: 'Some Other Name', code: 'COMP' });
    expect(res.status).toBe(409);
  });

  it('lists departments with student counts', async () => {
    const res = await request(app).get('/api/v1/departments').set(auth(superToken));
    expect(res.status).toBe(200);
    const comp = res.body.items.find((d: { code: string }) => d.code === 'COMP');
    expect(comp).toBeDefined();
    expect(comp._count.students).toBe(0);
  });

  it('refuses to delete a department referenced by students (409)', async () => {
    const student = await createTestStudent(pool, { rollPrefix: 'DR' });
    const studentRow = await prisma.student.findUnique({ where: { id: student.id } });
    const res = await request(app)
      .delete(`/api/v1/departments/${studentRow!.departmentId}`)
      .set(auth(superToken));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Deactivate it instead');
  });

  it('deletes an unreferenced department', async () => {
    const res = await request(app).delete(`/api/v1/departments/${deptId}`).set(auth(superToken));
    expect(res.status).toBe(200);
    const gone = await prisma.department.findUnique({ where: { id: deptId } });
    expect(gone).toBeNull();
  });

  it('returns 404 for unknown ids', async () => {
    const res = await request(app)
      .delete('/api/v1/departments/00000000-0000-4000-8000-000000000000')
      .set(auth(superToken));
    expect(res.status).toBe(404);
  });
});
