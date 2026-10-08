import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
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
let examToken: string;
let studentToken: string;

let year1Id: string;
let year2Id: string;
let deptId: string;
let exam1Id: string;
let exam2Id: string;

function isoDay(offsetDays: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return new Date(d.toISOString().slice(0, 10));
}

beforeAll(async () => {
  pool = createTestPool(5);
  await truncateAll(pool);
  app = createApp();

  superAdmin = await createTestUser(pool, { role: 'SUPER_ADMIN', password: PW, email: 'sa-dash@test.local' });
  const examAdmin = await createTestUser(pool, { role: 'EXAM_ADMIN', password: PW, email: 'ea-dash@test.local' });
  superToken = (
    await request(app).post('/api/v1/auth/login').send({ identifier: superAdmin.email, password: PW })
  ).body.accessToken;
  examToken = (
    await request(app).post('/api/v1/auth/login').send({ identifier: examAdmin.email, password: PW })
  ).body.accessToken;
  const studentUser = await createTestUser(pool, { role: 'STUDENT', password: PW, email: 'stu-dash@test.local' });
  studentToken = (
    await request(app).post('/api/v1/auth/login').send({ identifier: studentUser.email!, password: PW })
  ).body.accessToken;

  const dept = await prisma.department.create({ data: { name: 'Dashboard Dept', code: 'DASHD' } });
  deptId = dept.id;
  const y1 = await prisma.academicYear.create({ data: { name: 'Dash Year 1', code: 'DASHY1' } });
  const y2 = await prisma.academicYear.create({ data: { name: 'Dash Year 2', code: 'DASHY2' } });
  year1Id = y1.id;
  year2Id = y2.id;

  // Year 1: 3 students. Year 2: 15 students.
  await prisma.student.createMany({
    data: [
      ...Array.from({ length: 3 }, (_, i) => ({
        rollNumber: `DSH1${i}`,
        name: `Dash Student 1-${i}`,
        academicYearId: year1Id,
        departmentId: deptId,
      })),
      ...Array.from({ length: 15 }, (_, i) => ({
        rollNumber: `DSH2${i}`,
        name: `Dash Student 2-${i}`,
        academicYearId: year2Id,
        departmentId: deptId,
      })),
    ],
  });

  // Two rooms: 12 + 2 = 14 seats total (both AVAILABLE).
  const roomA = await prisma.classroom.create({ data: { roomNumber: 'DASH-A', building: 'Main' } });
  const roomB = await prisma.classroom.create({ data: { roomNumber: 'DASH-B', building: 'Main' } });
  await prisma.seat.createMany({
    data: [
      ...Array.from({ length: 12 }, (_, i) => ({ classroomId: roomA.id, benchNumber: i + 1 })),
      ...Array.from({ length: 2 }, (_, i) => ({ classroomId: roomB.id, benchNumber: i + 1 })),
    ],
  });

  const time = (h: number) => new Date(Date.UTC(1970, 0, 1, h, 0, 0));
  const e1 = await prisma.exam.create({
    data: {
      subject: 'Dash Exam One',
      examDate: isoDay(7),
      startTime: time(9),
      endTime: time(12),
      academicYearId: year1Id,
    },
  });
  const e2 = await prisma.exam.create({
    data: {
      subject: 'Dash Exam Two',
      examDate: isoDay(8),
      startTime: time(9),
      endTime: time(12),
      academicYearId: year2Id,
    },
  });
  exam1Id = e1.id;
  exam2Id = e2.id;

  const year1Students = await prisma.student.findMany({ where: { academicYearId: year1Id }, select: { id: true } });
  const year2Students = await prisma.student.findMany({ where: { academicYearId: year2Id }, select: { id: true } });
  await prisma.examRegistration.createMany({
    data: [
      ...year1Students.map((s) => ({ examId: exam1Id, studentId: s.id })),
      ...year2Students.map((s) => ({ examId: exam2Id, studentId: s.id })),
    ],
  });
}, 60000);

afterAll(async () => {
  await pool.end();
  await disconnectPrisma();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('Phase 8: GET /dashboard/summary', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/v1/dashboard/summary');
    expect(res.status).toBe(401);
  });

  it('rejects STUDENT role with 403', async () => {
    const res = await request(app).get('/api/v1/dashboard/summary').set(auth(studentToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows EXAM_ADMIN', async () => {
    const res = await request(app).get('/api/v1/dashboard/summary').set(auth(examToken));
    expect(res.status).toBe(200);
  });

  it('reports real counts and detects the insufficient-seats conflict', async () => {
    const res = await request(app).get('/api/v1/dashboard/summary').set(auth(superToken));
    expect(res.status).toBe(200);
    const s = res.body.summary;
    expect(s.totalStudents).toBe(18);
    expect(s.totalDepartments).toBe(1);
    expect(s.totalClassrooms).toBe(2);
    expect(s.availableSeats).toBe(14);
    expect(s.upcomingExams).toBe(2);
    expect(s.generatedSeatingPlans).toBe(0);
    // Year 2 has 15 students but only 14 seats -> exactly one conflicting exam.
    expect(s.allocationConflicts).toBe(1);
  });

  it('generatedSeatingPlans increases after a real generation', async () => {
    const gen = await request(app)
      .post(`/api/v1/seating/exams/${exam1Id}/generate-seating`)
      .set(auth(superToken))
      .send({ seed: 'dash-seed', roomIds: [] });
    expect(gen.status).toBe(200);

    const res = await request(app).get('/api/v1/dashboard/summary').set(auth(superToken));
    expect(res.body.summary.generatedSeatingPlans).toBe(1);
    // Still only exam2 conflicts (exam1 now has a valid plan).
    expect(res.body.summary.allocationConflicts).toBe(1);
  });
});

describe('Phase 8: GET /dashboard/charts', () => {
  it('rejects STUDENT role with 403 and allows admins', async () => {
    expect((await request(app).get('/api/v1/dashboard/charts').set(auth(studentToken))).status).toBe(403);
    expect((await request(app).get('/api/v1/dashboard/charts').set(auth(examToken))).status).toBe(200);
  });

  it('returns students per department, seats vs students and plans by status', async () => {
    const res = await request(app).get('/api/v1/dashboard/charts').set(auth(superToken));
    expect(res.status).toBe(200);

    expect(res.body.studentsPerDepartment).toHaveLength(1);
    expect(res.body.studentsPerDepartment[0]).toMatchObject({ code: 'DASHD', count: 18 });

    expect(res.body.seatsVsStudents).toHaveLength(2);
    const bySubject = new Map(res.body.seatsVsStudents.map((r: { subject: string }) => [r.subject, r]));
    expect(bySubject.get('Dash Exam One')).toMatchObject({ eligibleCount: 3, availableSeats: 14 });
    expect(bySubject.get('Dash Exam Two')).toMatchObject({ eligibleCount: 15, availableSeats: 14 });

    const statusMap = new Map(
      res.body.plansByStatus.map((r: { status: string; count: number }) => [r.status, r.count]),
    );
    expect(statusMap.get('VALIDATED')).toBe(1);
    expect(statusMap.get('NOT_GENERATED')).toBe(1);
    expect(statusMap.get('PUBLISHED')).toBe(0);
  });
});
