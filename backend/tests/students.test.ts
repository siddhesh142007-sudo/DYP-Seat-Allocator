import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestPool, truncateAll } from './helpers/db.js';
import { createTestUser, type TestUser } from './helpers/auth.js';
import { createApp } from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/db/prisma.js';

const PW = 'AdminSecret123!';

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let superAdmin: TestUser;
let superToken: string;
let yearId: string;
let deptId: string;
let otherDeptId: string;

beforeAll(async () => {
  pool = createTestPool(5);
  await truncateAll(pool);
  app = createApp();
  superAdmin = await createTestUser(pool, { role: 'SUPER_ADMIN', password: PW, email: 'sa-stu@test.local' });
  superToken = (await request(app).post('/api/v1/auth/login').send({ identifier: superAdmin.email, password: PW })).body
    .accessToken;

  const suffix = randomUUID().slice(0, 8);
  yearId = (
    await prisma.academicYear.create({ data: { name: `Students Year ${suffix}`, code: `SY${suffix}` } })
  ).id;
  deptId = (await prisma.department.create({ data: { name: `Students Dept ${suffix}`, code: `SD${suffix}` } })).id;
  otherDeptId = (await prisma.department.create({ data: { name: `Other Dept ${suffix}`, code: `OD${suffix}` } })).id;
}, 60000);

afterAll(async () => {
  await pool.end();
  await disconnectPrisma();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createStudent(overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/students')
    .set(auth(superToken))
    .send({
      rollNumber: `R${randomUUID().slice(0, 10)}`,
      name: 'Test Student',
      academicYearId: yearId,
      departmentId: deptId,
      ...overrides,
    });
  return res;
}

describe('POST /students', () => {
  it('rejects anonymous requests with 401', async () => {
    const res = await request(app)
      .post('/api/v1/students')
      .send({ rollNumber: 'X1', name: 'N', academicYearId: yearId, departmentId: deptId });
    expect(res.status).toBe(401);
  });

  it('creates a student without login', async () => {
    const res = await createStudent({ name: 'No Login Yet' });
    expect(res.status).toBe(201);
    expect(res.body.student).toMatchObject({ name: 'No Login Yet', status: 'ACTIVE' });
    expect(res.body.student.user).toBeNull();
    expect(res.body.student.academicYear.id).toBe(yearId);
    expect(res.body.student.department.id).toBe(deptId);
  });

  it('never creates a login account for a student (admin-only system)', async () => {
    const roll = `LG${randomUUID().slice(0, 8)}`;
    const res = await createStudent({ rollNumber: roll, name: 'No Login Student', email: `${roll}@test.local` });
    expect(res.status).toBe(201);
    expect(res.body.student.user).toBeNull();
    // No user row exists for this roll number, and roll-number login is refused.
    expect(await prisma.user.count({ where: { student: { rollNumber: roll } } })).toBe(0);
    const login = await request(app).post('/api/v1/auth/login').send({ identifier: roll, password: 'anything123' });
    expect(login.status).toBe(401);
  });

  it('rejects duplicate roll numbers with 409', async () => {
    const roll = `DUP${randomUUID().slice(0, 8)}`;
    expect((await createStudent({ rollNumber: roll })).status).toBe(201);
    const again = await createStudent({ rollNumber: roll });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain('roll number');
  });

  it('404s for unknown year or department', async () => {
    const badYear = await createStudent({ academicYearId: randomUUID() });
    expect(badYear.status).toBe(404);
    const badDept = await createStudent({ departmentId: randomUUID() });
    expect(badDept.status).toBe(404);
  });

  it('400s on a malformed payload', async () => {
    const res = await request(app).post('/api/v1/students').set(auth(superToken)).send({ name: 'No ids' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /students', () => {
  it('paginates, sorts and filters', async () => {
    const base = await createStudent({ name: 'Filter Target', division: 'Z' });
    expect(base.status).toBe(201);

    const search = await request(app)
      .get('/api/v1/students')
      .query({ search: base.body.student.rollNumber })
      .set(auth(superToken));
    expect(search.status).toBe(200);
    expect(search.body.total).toBe(1);
    expect(search.body.items[0].rollNumber).toBe(base.body.student.rollNumber);

    const byDept = await request(app).get('/api/v1/students').query({ departmentId: deptId }).set(auth(superToken));
    expect(byDept.status).toBe(200);
    expect(byDept.body.items.every((s: { departmentId: string }) => s.departmentId === deptId)).toBe(true);

    const byDivision = await request(app).get('/api/v1/students').query({ division: 'z' }).set(auth(superToken));
    expect(byDivision.body.items).toHaveLength(1);

    const page = await request(app)
      .get('/api/v1/students')
      .query({ pageSize: 2, page: 1, sort: 'rollNumber', order: 'asc' })
      .set(auth(superToken));
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.total).toBeGreaterThan(2);
    expect(page.body.page).toBe(1);
  });

  it('400s on an invalid sort field', async () => {
    const res = await request(app).get('/api/v1/students').query({ sort: 'password_hash' }).set(auth(superToken));
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/v1/students');
    expect(res.status).toBe(401);
  });
});

describe('PUT /students/:id and DELETE /students/:id', () => {
  it('updates fields and tracks status on deactivate/reactivate', async () => {
    const roll = `UP${randomUUID().slice(0, 8)}`;
    const created = await createStudent({ rollNumber: roll, name: 'Before Update' });
    const id = created.body.student.id;

    const updated = await request(app)
      .put(`/api/v1/students/${id}`)
      .set(auth(superToken))
      .send({ name: 'After Update', departmentId: otherDeptId, division: 'B' });
    expect(updated.status).toBe(200);
    expect(updated.body.student).toMatchObject({ name: 'After Update', division: 'B', departmentId: otherDeptId });

    const deactivated = await request(app).delete(`/api/v1/students/${id}`).set(auth(superToken));
    expect(deactivated.status).toBe(200);

    // Deactivate is a soft delete: the row survives with status INACTIVE and
    // no user account is involved (DYPIT is administrator-only).
    const student = await prisma.student.findUnique({ where: { id } });
    expect(student!.status).toBe('INACTIVE');
    expect(await prisma.user.count({ where: { studentId: id } })).toBe(0);

    const reactivated = await request(app)
      .put(`/api/v1/students/${id}`)
      .set(auth(superToken))
      .send({ status: 'ACTIVE' });
    expect(reactivated.status).toBe(200);
    expect((await prisma.student.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'student.deactivate', entityId: id } });
    expect(audit).not.toBeNull();
  });

  it('404s for unknown students', async () => {
    const res = await request(app)
      .put('/api/v1/students/00000000-0000-4000-8000-000000000000')
      .set(auth(superToken))
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });
});
