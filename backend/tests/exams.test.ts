import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestPool, truncateAll } from './helpers/db.js';
import { createTestUser, createTestStudent, type TestUser } from './helpers/auth.js';
import { createApp } from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/db/prisma.js';

const PW = 'AdminSecret123!';
const EXAM_DATE = '2026-11-15';

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let superAdmin: TestUser;
let studentUser: TestUser;
let superToken: string;
let studentToken: string;
let yearA: string;
let yearB: string;
let deptX: string;
let deptY: string;
let s1: string;
let s2: string;
let s3: string;
let inactiveStudent: string;
let otherYearStudent: string;
let room1: string;
let room2: string;
const suffix = randomUUID().slice(0, 8);

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface ExamDto {
  id: string;
  subject: string;
  status: string;
  examDate: string;
  startTime: string;
  endTime: string;
  seatingStatus: string;
  isStale: boolean;
  registrationCount?: number;
}

interface Conflict {
  code: string;
  message: string;
  details?: {
    exams?: Array<{ id: string; subject: string; examDate: string; startTime: string; endTime: string; hasSeatingPlan: boolean; blockedRooms: number }>;
    eligibleCount?: number;
    availableSeats?: number;
    shortfall?: number;
    availableRooms?: number;
    blockedRooms?: number;
  };
}

function conflictsOf(body: { conflicts?: Conflict[] }): Conflict[] {
  return body.conflicts ?? [];
}

async function createRoom(roomNumber: string): Promise<{ id: string; seats: string[] }> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO classrooms (id, room_number, building, floor, status, capacity)
     VALUES ($1, $2, 'Main', '1', 'AVAILABLE', 0)`,
    [id, roomNumber],
  );
  const seats: string[] = [];
  for (const bench of [1, 2]) {
    const seatId = randomUUID();
    seats.push(seatId);
    await pool.query(
      `INSERT INTO seats (id, classroom_id, bench_number, status, row_no, col_no)
       VALUES ($1, $2, $3, 'AVAILABLE', $3, 1)`,
      [seatId, id, bench],
    );
  }
  return { id, seats };
}

async function mkExam(overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/exams')
    .set(auth(superToken))
    .send({
      subject: `Exam ${randomUUID().slice(0, 8)}`,
      examDate: EXAM_DATE,
      startTime: '09:00',
      endTime: '12:00',
      academicYearId: yearA,
      ...overrides,
    });
  expect(res.status).toBe(201);
  return res.body.exam as ExamDto;
}

beforeAll(async () => {
  pool = createTestPool(5);
  await truncateAll(pool);
  app = createApp();
  superAdmin = await createTestUser(pool, { role: 'SUPER_ADMIN', password: PW, email: `sa-exam-${suffix}@test.local` });
  const studentRow = await createTestStudent(pool, { rollPrefix: 'EX' });
  studentUser = await createTestUser(pool, { role: 'STUDENT', password: PW, studentId: studentRow.id });
  superToken = (await request(app).post('/api/v1/auth/login').send({ identifier: superAdmin.email, password: PW }))
    .body.accessToken;
  studentToken = (await request(app).post('/api/v1/auth/login').send({ identifier: studentUser.email, password: PW }))
    .body.accessToken;

  yearA = (await prisma.academicYear.create({ data: { name: `Exam Year A ${suffix}`, code: `EA${suffix}` } })).id;
  yearB = (await prisma.academicYear.create({ data: { name: `Exam Year B ${suffix}`, code: `EB${suffix}` } })).id;
  deptX = (await prisma.department.create({ data: { name: `Exam Dept X ${suffix}`, code: `DX${suffix}` } })).id;
  deptY = (await prisma.department.create({ data: { name: `Exam Dept Y ${suffix}`, code: `DY${suffix}` } })).id;

  const mkStudent = async (year: string, dept: string, status: 'ACTIVE' | 'INACTIVE') =>
    (
      await prisma.student.create({
        data: {
          rollNumber: `E${randomUUID().slice(0, 12)}`,
          name: `Student ${randomUUID().slice(0, 8)}`,
          status,
          academicYearId: year,
          departmentId: dept,
        },
      })
    ).id;

  s1 = await mkStudent(yearA, deptX, 'ACTIVE');
  s2 = await mkStudent(yearA, deptX, 'ACTIVE');
  s3 = await mkStudent(yearA, deptY, 'ACTIVE');
  inactiveStudent = await mkStudent(yearA, deptX, 'INACTIVE');
  otherYearStudent = await mkStudent(yearB, deptX, 'ACTIVE');

  room1 = (await createRoom(`EX1-${suffix}`)).id;
  room2 = (await createRoom(`EX2-${suffix}`)).id;
}, 60000);

afterAll(async () => {
  await pool.end();
  await disconnectPrisma();
});

describe('exams CRUD', () => {
  it('creates an exam and auto-registers only ACTIVE students of its academic year', async () => {
    const exam = await mkExam();
    expect(exam.registrationCount).toBe(3); // s1,s2,s3 — not inactive, not other year
    expect(exam.startTime).toBe('09:00');
    expect(exam.endTime).toBe('12:00');
    expect(exam.examDate).toBe(EXAM_DATE);
    expect(exam.seatingStatus).toBe('NOT_GENERATED');
    expect(exam.isStale).toBe(false);

    const detail = (await request(app).get(`/api/v1/exams/${exam.id}`).set(auth(superToken))).body;
    expect(detail.exam.eligibleCount).toBe(3);
    expect(detail.exam.registrationCounts).toEqual({ REGISTERED: 3, ABSENT: 0, WITHHELD: 0, REMOVED: 0 });
  });

  it('does not register anyone when autoRegister=false', async () => {
    const exam = await mkExam({ autoRegister: false });
    expect(exam.registrationCount).toBe(0);
  });

  it('rejects an exam whose endTime is not after startTime', async () => {
    const res = await request(app)
      .post('/api/v1/exams')
      .set(auth(superToken))
      .send({ subject: 'Bad', examDate: EXAM_DATE, startTime: '12:00', endTime: '09:00', academicYearId: yearA });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('404s for an unknown academic year', async () => {
    const res = await request(app)
      .post('/api/v1/exams')
      .set(auth(superToken))
      .send({ subject: 'No year', examDate: EXAM_DATE, startTime: '09:00', endTime: '10:00', academicYearId: randomUUID() });
    expect(res.status).toBe(404);
  });

  it('lists and filters exams', async () => {
    const subject = `Filterable ${suffix}`;
    await mkExam({ subject });
    const list = await request(app).get('/api/v1/exams').set(auth(superToken)).query({ search: subject });
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].subject).toBe(subject);

    const byStatus = await request(app).get('/api/v1/exams').set(auth(superToken)).query({ status: 'CANCELLED' });
    expect(byStatus.body.items.every((e: { status: string }) => e.status === 'CANCELLED')).toBe(true);

    const byDate = await request(app)
      .get('/api/v1/exams')
      .set(auth(superToken))
      .query({ dateFrom: EXAM_DATE, dateTo: EXAM_DATE });
    expect(byDate.body.items.every((e: { examDate: string }) => e.examDate === EXAM_DATE)).toBe(true);
  });

  it('updates exam fields and validates the time window', async () => {
    const exam = await mkExam();
    const ok = await request(app)
      .put(`/api/v1/exams/${exam.id}`)
      .set(auth(superToken))
      .send({ subject: 'Renamed Subject', endTime: '13:00' });
    expect(ok.status).toBe(200);
    expect(ok.body.exam.subject).toBe('Renamed Subject');
    expect(ok.body.exam.endTime).toBe('13:00');

    const bad = await request(app)
      .put(`/api/v1/exams/${exam.id}`)
      .set(auth(superToken))
      .send({ startTime: '14:00' }); // 14:00 > existing 13:00 end
    expect(bad.status).toBe(400);
  });

  it('blocks edits while the seating plan is PUBLISHED', async () => {
    const exam = await mkExam();
    await pool.query(`UPDATE exams SET seating_status = 'PUBLISHED' WHERE id = $1`, [exam.id]);
    const res = await request(app).put(`/api/v1/exams/${exam.id}`).set(auth(superToken)).send({ subject: 'Nope' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/published/i);
    await pool.query(`UPDATE exams SET seating_status = 'NOT_GENERATED' WHERE id = $1`, [exam.id]);
  });

  it('sets isStale when the schedule changes on an exam that has a plan', async () => {
    const exam = await mkExam();
    await pool.query(`INSERT INTO seating_runs (id, exam_id, seed, status, algorithm_version, config)
                      VALUES ($1, $2, 'seed', 'DRAFT', 'v1', '{}')`, [randomUUID(), exam.id]);
    const res = await request(app)
      .put(`/api/v1/exams/${exam.id}`)
      .set(auth(superToken))
      .send({ startTime: '10:00' });
    expect(res.status).toBe(200);
    expect(res.body.exam.isStale).toBe(true);
  });

  it('blocks academic-year changes once seating runs exist', async () => {
    const exam = await mkExam();
    await pool.query(`INSERT INTO seating_runs (id, exam_id, seed, status, algorithm_version, config)
                      VALUES ($1, $2, 'seed', 'DRAFT', 'v1', '{}')`, [randomUUID(), exam.id]);
    const res = await request(app)
      .put(`/api/v1/exams/${exam.id}`)
      .set(auth(superToken))
      .send({ academicYearId: yearB });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/seating plan/i);
  });

  it('deletes an exam only when it has no seating runs (registrations cascade)', async () => {
    const withRuns = await mkExam();
    await pool.query(`INSERT INTO seating_runs (id, exam_id, seed, status, algorithm_version, config)
                      VALUES ($1, $2, 'seed', 'DRAFT', 'v1', '{}')`, [randomUUID(), withRuns.id]);
    const blocked = await request(app).delete(`/api/v1/exams/${withRuns.id}`).set(auth(superToken));
    expect(blocked.status).toBe(409);

    const clean = await mkExam();
    const ok = await request(app).delete(`/api/v1/exams/${clean.id}`).set(auth(superToken));
    expect(ok.status).toBe(200);
    expect(await prisma.exam.findUnique({ where: { id: clean.id } })).toBeNull();
    expect(await prisma.examRegistration.count({ where: { examId: clean.id } })).toBe(0);
  });
});

describe('registration management', () => {
  it('marks students ABSENT/WITHHELD/REMOVED and re-adds them, updating eligibleCount', async () => {
    const exam = await mkExam();

    const absent = await request(app)
      .patch(`/api/v1/exams/${exam.id}/registrations/${s1}`)
      .set(auth(superToken))
      .send({ status: 'ABSENT' });
    expect(absent.status).toBe(200);
    expect(absent.body.registration.status).toBe('ABSENT');

    let detail = (await request(app).get(`/api/v1/exams/${exam.id}`).set(auth(superToken))).body;
    expect(detail.exam.eligibleCount).toBe(2);
    expect(detail.exam.registrationCounts.ABSENT).toBe(1);

    const readd = await request(app)
      .patch(`/api/v1/exams/${exam.id}/registrations/${s1}`)
      .set(auth(superToken))
      .send({ status: 'REGISTERED' });
    expect(readd.status).toBe(200);
    detail = (await request(app).get(`/api/v1/exams/${exam.id}`).set(auth(superToken))).body;
    expect(detail.exam.eligibleCount).toBe(3);
  });

  it('404s for a student with no registration row', async () => {
    const exam = await mkExam({ autoRegister: false });
    const res = await request(app)
      .patch(`/api/v1/exams/${exam.id}/registrations/${randomUUID()}`)
      .set(auth(superToken))
      .send({ status: 'ABSENT' });
    expect(res.status).toBe(404);
  });

  it('flags the exam stale when registration changes after a plan exists', async () => {
    const exam = await mkExam();
    await pool.query(`INSERT INTO seating_runs (id, exam_id, seed, status, algorithm_version, config)
                      VALUES ($1, $2, 'seed', 'DRAFT', 'v1', '{}')`, [randomUUID(), exam.id]);
    const res = await request(app)
      .patch(`/api/v1/exams/${exam.id}/registrations/${s2}`)
      .set(auth(superToken))
      .send({ status: 'WITHHELD' });
    expect(res.status).toBe(200);
    expect(res.body.examIsStale).toBe(true);
    const after = await prisma.exam.findUniqueOrThrow({ where: { id: exam.id } });
    expect(after.isStale).toBe(true);
  });

  it('adds students after creation and rejects invalid ones', async () => {
    const exam = await mkExam({ autoRegister: false });

    // Wrong year -> 422
    const wrongYear = await request(app)
      .post(`/api/v1/exams/${exam.id}/registrations`)
      .set(auth(superToken))
      .send({ studentId: otherYearStudent });
    expect(wrongYear.status).toBe(400);
    expect(wrongYear.body.error.message).toMatch(/academic year/i);

    // Inactive -> 400/422
    const inactive = await request(app)
      .post(`/api/v1/exams/${exam.id}/registrations`)
      .set(auth(superToken))
      .send({ studentId: inactiveStudent });
    expect(inactive.status).toBeGreaterThanOrEqual(400);
    expect(inactive.status).toBeLessThan(500);

    // Valid adds
    const add1 = await request(app)
      .post(`/api/v1/exams/${exam.id}/registrations`)
      .set(auth(superToken))
      .send({ studentId: s1 });
    expect(add1.status).toBe(201);
    expect(add1.body.registration.status).toBe('REGISTERED');

    const dup = await request(app)
      .post(`/api/v1/exams/${exam.id}/registrations`)
      .set(auth(superToken))
      .send({ studentId: s1 });
    expect(dup.status).toBe(409);

    // Remove then re-add the same student.
    await request(app)
      .patch(`/api/v1/exams/${exam.id}/registrations/${s1}`)
      .set(auth(superToken))
      .send({ status: 'REMOVED' });
    const readd = await request(app)
      .post(`/api/v1/exams/${exam.id}/registrations`)
      .set(auth(superToken))
      .send({ studentId: s1 });
    expect(readd.status).toBe(201);
    expect(readd.body.registration.status).toBe('REGISTERED');

    const detail = (await request(app).get(`/api/v1/exams/${exam.id}`).set(auth(superToken))).body;
    expect(detail.exam.eligibleCount).toBe(1);
  });

  it('lists registrations with filters and pagination', async () => {
    const exam = await mkExam();
    const page1 = await request(app)
      .get(`/api/v1/exams/${exam.id}/registrations`)
      .set(auth(superToken))
      .query({ pageSize: 2, page: 1 });
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.total).toBe(3);

    const byDept = await request(app)
      .get(`/api/v1/exams/${exam.id}/registrations`)
      .set(auth(superToken))
      .query({ departmentId: deptY });
    expect(byDept.body.total).toBe(1);
    expect(byDept.body.items[0].student.department.id).toBe(deptY);

    const search = await request(app)
      .get(`/api/v1/exams/${exam.id}/registrations`)
      .set(auth(superToken))
      .query({ status: 'REGISTERED' });
    expect(search.body.total).toBe(3);
  });
});

describe('eligible students', () => {
  it('returns only REGISTERED + ACTIVE students of the exam year, with filters', async () => {
    const exam = await mkExam();
    await request(app)
      .patch(`/api/v1/exams/${exam.id}/registrations/${s3}`)
      .set(auth(superToken))
      .send({ status: 'ABSENT' });

    const all = await request(app).get(`/api/v1/exams/${exam.id}/eligible-students`).set(auth(superToken));
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(
      all.body.items.every(
        (i: { status: string; student: { status: string } }) => i.status === 'REGISTERED' && i.student.status === 'ACTIVE',
      ),
    ).toBe(true);
    expect(all.body.items.some((i: { studentId: string }) => i.studentId === s3)).toBe(false);
    expect(all.body.items.some((i: { studentId: string }) => i.studentId === inactiveStudent)).toBe(false);
    expect(all.body.items.some((i: { studentId: string }) => i.studentId === otherYearStudent)).toBe(false);

    const deptFiltered = await request(app)
      .get(`/api/v1/exams/${exam.id}/eligible-students`)
      .set(auth(superToken))
      .query({ departmentId: deptY });
    expect(deptFiltered.body.total).toBe(0); // s3 is ABSENT, no other deptY students registered

    const paged = await request(app)
      .get(`/api/v1/exams/${exam.id}/eligible-students`)
      .set(auth(superToken))
      .query({ pageSize: 1, page: 2 });
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.total).toBe(2);
  });

  it('never includes students from other academic years', async () => {
    const exam = await mkExam({ academicYearId: yearB, autoRegister: false });
    // yearB has only otherYearStudent
    const addWrong = await request(app)
      .post(`/api/v1/exams/${exam.id}/registrations`)
      .set(auth(superToken))
      .send({ studentId: s1 });
    expect(addWrong.status).toBe(400);
    const stats = await request(app).get(`/api/v1/exams/${exam.id}/eligible-students`).set(auth(superToken));
    expect(stats.body.total).toBe(0);
  });
});

describe('seating preview stats', () => {
  it('reports eligible, seats, greedy rooms and department breakdown', async () => {
    const exam = await mkExam({ examDate: '2026-12-01' });
    const res = await request(app).get(`/api/v1/exams/${exam.id}/seating-preview-stats`).set(auth(superToken));
    expect(res.status).toBe(200);
    expect(res.body.eligibleCount).toBe(3);
    expect(res.body.availableSeats).toBe(4); // 2 rooms x 2 seats
    expect(res.body.availableRooms).toBe(2);
    expect(res.body.classroomsRequired).toBe(2); // 2-seat rooms: 2+2 >= 3
    expect(res.body.roomsBlockedByOtherExams.count).toBe(0);
    expect(res.body.conflicts).toEqual([]);
    const breakdown = res.body.departmentsBreakdown;
    expect(breakdown).toHaveLength(2);
    expect(breakdown[0].count).toBeGreaterThanOrEqual(breakdown[1].count);
    expect(breakdown.find((d: { code: string; count: number }) => d.code === `DX${suffix}`)?.count).toBe(2);
    expect(breakdown.find((d: { code: string; count: number }) => d.code === `DY${suffix}`)?.count).toBe(1);
  });

  it('detects clashing exams and excludes their planned rooms from the pool', async () => {
    const base = await mkExam({ examDate: '2026-12-02' }); // 09:00-12:00
    // Give the base exam a DRAFT plan holding room1.
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO seating_runs (id, exam_id, seed, status, algorithm_version, config)
       VALUES ($1, $2, 'seed', 'DRAFT', 'v1', '{}')`,
      [runId, base.id],
    );
    const seat = (await pool.query(`SELECT id FROM seats WHERE classroom_id = $1 LIMIT 1`, [room1])).rows[0].id;
    await pool.query(
      `INSERT INTO seating_allocations (id, run_id, exam_id, student_id, classroom_id, seat_id, academic_year_id, department_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), runId, base.id, s1, room1, seat, yearA, deptX],
    );

    const clash = await mkExam({ examDate: '2026-12-02', startTime: '10:00', endTime: '11:00' });
    const res = await request(app).get(`/api/v1/exams/${clash.id}/seating-preview-stats`).set(auth(superToken));
    expect(res.status).toBe(200);
    expect(res.body.roomsBlockedByOtherExams.count).toBe(1);
    expect(res.body.roomsBlockedByOtherExams.rooms[0].classroomId).toBe(room1);
    expect(res.body.roomsBlockedByOtherExams.rooms[0].blockingExamId).toBe(base.id);
    expect(res.body.roomsBlockedByOtherExams.rooms[0].classroomId).not.toBe(room2);
    expect(res.body.availableRooms).toBe(1);
    expect(res.body.availableSeats).toBe(2); // only room2 left
    const clashConflict = conflictsOf(res.body).find((c) => c.code === 'CLASHING_EXAM_SLOT');
    expect(clashConflict).toBeTruthy();
    expect(clashConflict?.details?.exams?.[0]).toMatchObject({ id: base.id, hasSeatingPlan: true, blockedRooms: 1 });
    expect(conflictsOf(res.body).some((c) => c.code === 'INSUFFICIENT_SEATS')).toBe(true);
  });

  it('does not treat a non-overlapping slot or another date as a clash', async () => {
    const base = await mkExam(); // 09:00-12:00 on EXAM_DATE
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO seating_runs (id, exam_id, seed, status, algorithm_version, config)
       VALUES ($1, $2, 'seed', 'DRAFT', 'v1', '{}')`,
      [runId, base.id],
    );
    const seat = (await pool.query(`SELECT id FROM seats WHERE classroom_id = $1 LIMIT 1`, [room1])).rows[0].id;
    await pool.query(
      `INSERT INTO seating_allocations (id, run_id, exam_id, student_id, classroom_id, seat_id, academic_year_id, department_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), runId, base.id, s1, room1, seat, yearA, deptX],
    );

    const sameDayLater = await mkExam({ examDate: '2026-12-03', startTime: '13:00', endTime: '15:00' });
    const later = await request(app).get(`/api/v1/exams/${sameDayLater.id}/seating-preview-stats`).set(auth(superToken));
    expect(later.body.roomsBlockedByOtherExams.count).toBe(0);
    expect(later.body.availableRooms).toBe(2);

    const otherDay = await mkExam({ examDate: '2026-12-04', startTime: '10:00', endTime: '11:00' });
    const other = await request(app).get(`/api/v1/exams/${otherDay.id}/seating-preview-stats`).set(auth(superToken));
    expect(conflictsOf(other.body).some((c) => c.code === 'CLASHING_EXAM_SLOT')).toBe(false);
    expect(other.body.availableRooms).toBe(2);
  });

  it('reports NO_ELIGIBLE_STUDENTS when nobody is registered', async () => {
    const exam = await mkExam({ examDate: '2026-12-05', autoRegister: false });
    const res = await request(app).get(`/api/v1/exams/${exam.id}/seating-preview-stats`).set(auth(superToken));
    expect(res.body.eligibleCount).toBe(0);
    expect(res.body.classroomsRequired).toBe(0);
    expect(conflictsOf(res.body).some((c) => c.code === 'NO_ELIGIBLE_STUDENTS')).toBe(true);
    expect(conflictsOf(res.body).some((c) => c.code === 'INSUFFICIENT_SEATS')).toBe(false);
  });

  it('reports INSUFFICIENT_SEATS with a shortfall when students exceed seats', async () => {
    for (let i = 0; i < 5; i++) {
      await prisma.student.create({
        data: {
          rollNumber: `E${randomUUID().slice(0, 12)}`,
          name: `Overflow ${i} ${suffix}`,
          status: 'ACTIVE',
          academicYearId: yearA,
          departmentId: deptX,
        },
      });
    }
    const exam = await mkExam({ examDate: '2026-12-06' });
    const res = await request(app).get(`/api/v1/exams/${exam.id}/seating-preview-stats`).set(auth(superToken));
    expect(res.body.eligibleCount).toBe(8); // 3 original + 5 overflow
    const conflict = conflictsOf(res.body).find((c) => c.code === 'INSUFFICIENT_SEATS');
    expect(conflict).toBeTruthy();
    expect(conflict?.details).toMatchObject({ eligibleCount: 8, availableSeats: 4, shortfall: 4 });
    expect(res.body.classroomsRequired).toBe(2); // greedy fills both rooms and still falls short
  });
});

describe('permissions and audit', () => {
  it('requires authentication and admin roles', async () => {
    expect((await request(app).get('/api/v1/exams')).status).toBe(401);
    expect((await request(app).post('/api/v1/exams').send({})).status).toBe(401);
    expect(
      (await request(app).post('/api/v1/exams').set(auth(studentToken)).send({ subject: 'x' })).status,
    ).toBe(403);
    expect((await request(app).get('/api/v1/exams').set(auth(studentToken))).status).toBe(403);
  });

  it('writes audit logs for exam mutations', async () => {
    const exam = await mkExam();
    await request(app).put(`/api/v1/exams/${exam.id}`).set(auth(superToken)).send({ subject: 'Audited' });
    const audit = await request(app).get('/api/v1/audit-logs').set(auth(superToken)).query({ action: 'exam.update' });
    expect(audit.status).toBe(200);
    expect(audit.body.total).toBeGreaterThanOrEqual(1);
    const createAudit = await request(app).get('/api/v1/audit-logs').set(auth(superToken)).query({ action: 'exam.create' });
    expect(createAudit.body.total).toBeGreaterThanOrEqual(1);
  });
});
