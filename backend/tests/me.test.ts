import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestPool, truncateAll } from './helpers/db.js';
import { createTestUser, type TestUser } from './helpers/auth.js';
import { createApp } from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/db/prisma.js';

const PW = 'PortalSecret123!';

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let superAdmin: TestUser;
let superToken: string;
let me: TestUser;
let meToken: string;
let adminlessStudentToken: string;
const suffix = randomUUID().slice(0, 8);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let yearId: string;
let deptId: string;
let myStudentId: string;
let myRoll: string;
let otherStudentId: string;

/** Shared scenario: one published future exam + one published past exam + one draft exam. */
let futureExamId = '';
let futureSubject = '';
let futureRoomNumber = '';
let futureBench = 0;
let pastExamId = '';
let draftExamId = '';
let otherExamId = '';

async function login(identifier: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ identifier, password: PW });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function mkStudent(rollPrefix: string): Promise<string> {
  const s = await prisma.student.create({
    data: {
      rollNumber: `${rollPrefix}${randomUUID().slice(0, 10)}`,
      name: `Portal ${rollPrefix} ${suffix}`,
      status: 'ACTIVE',
      academicYearId: yearId,
      departmentId: deptId,
    },
  });
  return s.id;
}

async function mkRoom(roomNumber: string, benches: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO classrooms (id, room_number, building, floor, status, capacity) VALUES ($1, $2, 'Main', '1', 'AVAILABLE', $3)`,
    [id, roomNumber, benches],
  );
  for (let b = 1; b <= benches; b++) {
    await pool.query(
      `INSERT INTO seats (id, classroom_id, bench_number, status, row_no, col_no) VALUES ($1, $2, $3, 'AVAILABLE', $3, 1)`,
      [randomUUID(), id, b],
    );
  }
  return id;
}

async function mkExam(
  opts: { date: string; subject?: string; paperCode?: string },
): Promise<{ id: string; subject: string }> {
  const subject = opts.subject ?? `Portal Exam ${randomUUID().slice(0, 8)}`;
  const res = await request(app)
    .post('/api/v1/exams')
    .set(auth(superToken))
    .send({
      subject,
      paperCode: opts.paperCode ?? 'PP-01',
      examDate: opts.date,
      startTime: '10:00',
      endTime: '13:00',
      academicYearId: yearId,
      autoRegister: false,
    });
  expect(res.status).toBe(201);
  return { id: res.body.exam.id as string, subject };
}

async function generate(examId: string, roomIds: string[]): Promise<void> {
  const res = await request(app)
    .post(`/api/v1/seating/exams/${examId}/generate-seating`)
    .set(auth(superToken))
    .send({ mode: 'MIXED', seed: `portal-${suffix}`, roomIds });
  expect(res.status).toBe(200);
  expect(res.body.result.run.status).toBe('VALIDATED');
}

async function publish(examId: string): Promise<void> {
  const res = await request(app).post(`/api/v1/seating/exams/${examId}/publish`).set(auth(superToken));
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  pool = createTestPool(5);
  await truncateAll(pool);
  app = createApp();
  superAdmin = await createTestUser(pool, { role: 'SUPER_ADMIN', password: PW, email: `sa-portal-${suffix}@test.local` });
  superToken = await login(superAdmin.email);

  yearId = (await prisma.academicYear.create({ data: { name: `Portal Year ${suffix}`, code: `PY${suffix}` } })).id;
  deptId = (await prisma.department.create({ data: { name: `Portal Dept ${suffix}`, code: `PD${suffix}` } })).id;
  myStudentId = await mkStudent('PM');
  myRoll = (await prisma.student.findUniqueOrThrow({ where: { id: myStudentId } })).rollNumber;
  otherStudentId = await mkStudent('PO');

  me = await createTestUser(pool, { role: 'STUDENT', password: PW, studentId: myStudentId, name: 'Me Portal' });
  meToken = await login(me.email);

  await buildScenario();
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await pool.end();
});

async function buildScenario(): Promise<void> {
  const room = await mkRoom(`PORT-${suffix}`, 4);
  futureRoomNumber = `PORT-${suffix}`;

  const future = await mkExam({ date: '2099-05-10', subject: 'Future Subject', paperCode: 'PF-101' });
  futureExamId = future.id;
  futureSubject = future.subject;
  await prisma.examRegistration.createMany({
    data: [{ examId: futureExamId, studentId: myStudentId }, { examId: futureExamId, studentId: otherStudentId }],
  });
  await generate(futureExamId, [room]);
  await publish(futureExamId);

  const mine = await prisma.seatingAllocation.findFirstOrThrow({ where: { examId: futureExamId, studentId: myStudentId } });
  futureBench = (await prisma.seat.findUniqueOrThrow({ where: { id: mine.seatId } })).benchNumber;

  const past = await mkExam({ date: '2020-01-15', subject: 'Past Subject', paperCode: 'PP-202' });
  pastExamId = past.id;
  await prisma.examRegistration.createMany({ data: [{ examId: pastExamId, studentId: myStudentId }] });
  await generate(pastExamId, [room]);
  await publish(pastExamId);

  const draft = await mkExam({ date: '2099-06-11', subject: 'Draft Subject' });
  draftExamId = draft.id;
  await prisma.examRegistration.createMany({ data: [{ examId: draftExamId, studentId: myStudentId }] });
  await generate(draftExamId, [room]);

  const other = await mkExam({ date: '2099-07-12', subject: 'Other Subject' });
  otherExamId = other.id;
  await prisma.examRegistration.createMany({ data: [{ examId: otherExamId, studentId: otherStudentId }] });
  await generate(otherExamId, [room]);
  await publish(otherExamId);
}

describe('Phase 9: GET /me/seating', () => {
  it('requires authentication (401) and rejects non-STUDENT roles (403)', async () => {
    const anon = await request(app).get('/api/v1/me/seating');
    expect(anon.status).toBe(401);

    const admin = await request(app).get('/api/v1/me/seating').set(auth(superToken));
    expect(admin.status).toBe(403);
    expect(admin.body.error.code).toBe('FORBIDDEN');
  });

  it('rejects a STUDENT account with no linked student record (403)', async () => {
    const orphan = await createTestUser(pool, { role: 'STUDENT', password: PW, studentId: null, email: `orphan-${suffix}@test.local` });
    adminlessStudentToken = await login(orphan.email);
    const res = await request(app).get('/api/v1/me/seating').set(auth(adminlessStudentToken));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('not linked');
  });

  it('returns my exact seat for the published exam, and only mine', async () => {
    const res = await request(app).get('/api/v1/me/seating').set(auth(meToken));
    expect(res.status).toBe(200);
    const { upcoming, past } = res.body as {
      upcoming: Array<Record<string, unknown>>;
      past: Array<Record<string, unknown>>;
    };

    const future = upcoming.find((c) => c.examId === futureExamId);
    expect(future).toBeDefined();
    expect(future!.subject).toBe(futureSubject);
    expect(future!.paperCode).toBe('PF-101');
    expect(future!.date).toBe('2099-05-10');
    expect(future!.startTime).toBe('10:00');
    expect(future!.endTime).toBe('13:00');
    expect((future!.room as { roomNumber: string }).roomNumber).toBe(futureRoomNumber);
    expect((future!.room as { building: string }).building).toBe('Main');
    expect((future!.room as { floor: string }).floor).toBe('1');
    expect(future!.benchNumber).toBe(futureBench);

    // The other student's seat in the same exam must not surface for me,
    // and their solo exam must be absent entirely.
    expect(upcoming.filter((c) => c.examId === otherExamId)).toHaveLength(0);
    expect(upcoming.filter((c) => c.examId === futureExamId)).toHaveLength(1);
    expect(upcoming.filter((c) => c.examId === draftExamId)).toHaveLength(0);
    expect(past.some((c) => c.examId === futureExamId)).toBe(false);
  });

  it('keeps drafts invisible (nothing before publish) and past exams collapsed separately', async () => {
    const res = await request(app).get('/api/v1/me/seating').set(auth(meToken));
    expect(res.status).toBe(200);
    const { upcoming, past } = res.body as { upcoming: Array<{ examId: string }>; past: Array<{ examId: string }> };

    expect(upcoming.some((c) => c.examId === draftExamId)).toBe(false);
    expect(past.some((c) => c.examId === pastExamId)).toBe(true);
    expect(past.some((c) => c.examId === futureExamId)).toBe(false);
    expect(upcoming.some((c) => c.examId === pastExamId)).toBe(false);
  });
});

describe('Phase 9: students are strictly read-only', () => {
  it('returns 403 for every modification endpoint', async () => {
    const cases: Array<{ path: string; body: unknown }> = [
      { path: `/api/v1/seating/exams/${futureExamId}/generate-seating`, body: { mode: 'MIXED' } },
      { path: `/api/v1/seating/exams/${futureExamId}/regenerate-seating`, body: {} },
      { path: `/api/v1/seating/exams/${futureExamId}/publish`, body: {} },
      {
        path: '/api/v1/exams',
        body: { subject: 'Nope', examDate: '2099-01-01', startTime: '09:00', endTime: '10:00', academicYearId: yearId },
      },
      { path: '/api/v1/classrooms', body: { roomNumber: 'NOPE-1', capacity: 30 } },
      { path: '/api/v1/students/import', body: {} },
    ];
    for (const { path, body } of cases) {
      const res = await request(app).post(path).set(auth(meToken)).send(body as object);
      expect(res.status, `POST ${path}`).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('returns 403 for admin-only read routes', async () => {
    const paths = [
      `/api/v1/seating/exams/${futureExamId}/seating`,
      '/api/v1/users',
      '/api/v1/audit-logs',
      '/api/v1/dashboard/summary',
      '/api/v1/students',
      '/api/v1/classrooms',
      '/api/v1/exams',
    ];
    for (const path of paths) {
      const res = await request(app).get(path).set(auth(meToken));
      expect(res.status, `GET ${path}`).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('returns 403 when reading another student\'s seating, 200 for my own', async () => {
    const other = await request(app)
      .get(`/api/v1/seating/students/${otherStudentId}/seating-history`)
      .set(auth(meToken));
    expect(other.status).toBe(403);

    const own = await request(app)
      .get(`/api/v1/seating/students/${myStudentId}/seating-history`)
      .set(auth(meToken));
    expect(own.status).toBe(200);
  });
});

describe('Phase 9: GET /me/seating/slip/:examId', () => {
  it('returns a PDF slip for my published seat with the room/bench highlighted', async () => {
    const res = await request(app)
      .get(`/api/v1/me/seating/slip/${futureExamId}`)
      .set(auth(meToken))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment; filename="seating-slip-');
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    // pdfkit stores text as hex strings inside TJ arrays; decode them all.
    const text = pdf.toString('latin1');
    const decoded = [...text.matchAll(/<([0-9A-Fa-f]+)>/g)]
      .map((m) => Buffer.from(m[1], 'hex').toString('latin1'))
      .join('');
    expect(decoded).toContain('EXAM SEATING SLIP');
    expect(decoded).toContain(futureSubject);
    expect(decoded).toContain(myRoll);
    expect(decoded).toContain(`Room: ${futureRoomNumber}   /   Bench: ${futureBench}`);
  });

  it('is 404 for a draft exam, for another student\'s exam, for an unknown id, and 400 for a bad id', async () => {
    const draft = await request(app).get(`/api/v1/me/seating/slip/${draftExamId}`).set(auth(meToken));
    expect(draft.status).toBe(404);
    expect(draft.body.error.code).toBe('NOT_FOUND');

    const other = await request(app).get(`/api/v1/me/seating/slip/${otherExamId}`).set(auth(meToken));
    expect(other.status).toBe(404);

    const unknown = await request(app).get(`/api/v1/me/seating/slip/${randomUUID()}`).set(auth(meToken));
    expect(unknown.status).toBe(404);

    const malformed = await request(app).get('/api/v1/me/seating/slip/not-a-uuid').set(auth(meToken));
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');

    const anon = await request(app).get(`/api/v1/me/seating/slip/${futureExamId}`);
    expect(anon.status).toBe(401);
  });
});
