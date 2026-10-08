import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestPool, truncateAll, SQLSTATE } from './helpers/db.js';
import { createTestUser, type TestUser } from './helpers/auth.js';
import { createApp } from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/db/prisma.js';

const PW = 'AdminSecret123!';

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let superAdmin: TestUser;
let superToken: string;
let examAdmin: TestUser;
let examAdminToken: string;
const suffix = randomUUID().slice(0, 8);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let yearA: string;
let deptX: string;
let dayCounter = 0;

function nextDate(): string {
  dayCounter += 1;
  const day = ((dayCounter - 1) % 30) + 1;
  return `2026-11-${String(day).padStart(2, '0')}`;
}

async function login(identifier: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ identifier, password: PW });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function mkStudent(yearId: string = yearA, deptId: string = deptX): Promise<string> {
  const s = await prisma.student.create({
    data: {
      rollNumber: `S${randomUUID().slice(0, 12)}`,
      name: `Student ${randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
      academicYearId: yearId,
      departmentId: deptId,
    },
  });
  return s.id;
}

async function mkRoom(roomNumber: string, benches: number, status = 'AVAILABLE'): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO classrooms (id, room_number, building, floor, status, capacity) VALUES ($1, $2, 'Main', '1', $3, $4)`,
    [id, roomNumber, status, benches],
  );
  for (let b = 1; b <= benches; b++) {
    await pool.query(
      `INSERT INTO seats (id, classroom_id, bench_number, status, row_no, col_no) VALUES ($1, $2, $3, 'AVAILABLE', $3, 1)`,
      [randomUUID(), id, b],
    );
  }
  return id;
}

async function mkExam(opts: { date?: string; start?: string; end?: string; yearId?: string } = {}): Promise<string> {
  const res = await request(app)
    .post('/api/v1/exams')
    .set(auth(superToken))
    .send({
      subject: `Seating Exam ${randomUUID().slice(0, 8)}`,
      examDate: opts.date ?? nextDate(),
      startTime: opts.start ?? '09:00',
      endTime: opts.end ?? '12:00',
      academicYearId: opts.yearId ?? yearA,
      autoRegister: false,
    });
  expect(res.status).toBe(201);
  return res.body.exam.id as string;
}

async function registerBulk(examId: string, studentIds: string[]): Promise<void> {
  if (studentIds.length === 0) return;
  await prisma.examRegistration.createMany({
    data: studentIds.map((studentId) => ({ examId, studentId })),
  });
}

async function register(examId: string, studentId: string): Promise<void> {
  const res = await request(app)
    .post(`/api/v1/exams/${examId}/registrations`)
    .set(auth(superToken))
    .send({ studentId });
  expect(res.status).toBe(201);
}

async function mkStudents(n: number, yearId: string = yearA, deptId: string = deptX): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await mkStudent(yearId, deptId));
  return ids;
}

async function generate(examId: string, body: Record<string, unknown>, token: string = superToken) {
  return request(app).post(`/api/v1/seating/exams/${examId}/generate-seating`).set(auth(token)).send(body);
}

type AllocRow = { studentId: string; classroomId: string; seatId: string; benchNo: number };

async function allocations(examId: string): Promise<AllocRow[]> {
  const rows = await prisma.seatingAllocation.findMany({
    where: { examId },
    include: { seat: { select: { benchNumber: true } } },
  });
  return rows.map((a) => ({
    studentId: a.studentId,
    classroomId: a.classroomId,
    seatId: a.seatId,
    benchNo: a.seat.benchNumber,
  }));
}

async function seatMap(examId: string): Promise<Map<string, { roomId: string; seatId: string }>> {
  const rows = await allocations(examId);
  return new Map(rows.map((a) => [a.studentId, { roomId: a.classroomId, seatId: a.seatId }]));
}

function repeats(a: Map<string, { roomId: string; seatId: string }>, b: Map<string, { roomId: string; seatId: string }>) {
  let sameSeat = 0;
  let sameRoom = 0;
  let both = 0;
  for (const [sid, x] of a) {
    const y = b.get(sid);
    if (!y) continue;
    both += 1;
    if (x.seatId === y.seatId) sameSeat += 1;
    if (x.roomId === y.roomId) sameRoom += 1;
  }
  return { sameSeat, sameRoom, both };
}

beforeAll(async () => {
  pool = createTestPool(5);
  await truncateAll(pool);
  app = createApp();
  superAdmin = await createTestUser(pool, { role: 'SUPER_ADMIN', password: PW, email: `sa-seat-${suffix}@test.local` });
  examAdmin = await createTestUser(pool, { role: 'EXAM_ADMIN', password: PW, email: `ea-seat-${suffix}@test.local` });
  superToken = await login(superAdmin.email);
  examAdminToken = await login(examAdmin.email);
  yearA = (await prisma.academicYear.create({ data: { name: `Seat Year ${suffix}`, code: `SY${suffix}` } })).id;
  deptX = (await prisma.department.create({ data: { name: `Seat Dept ${suffix}`, code: `SD${suffix}` } })).id;
});

afterAll(async () => {
  await disconnectPrisma();
  await pool.end();
});

describe('Phase 7: generate-seating', () => {
  it('generates a VALIDATED run: every eligible student gets a unique seat, report stored, audit written', async () => {
    const room = await mkRoom(`SEAT-OK${suffix}`, 4);
    const examId = await mkExam();
    const ids = await mkStudents(3);
    await registerBulk(examId, ids);

    const res = await generate(examId, { mode: 'MIXED', seed: 'seed-1', roomIds: [room] });
    expect(res.status).toBe(200);
    expect(res.body.result.run.status).toBe('VALIDATED');
    const runId = res.body.result.run.id as string;

    const allocs = await allocations(examId);
    expect(allocs.length).toBe(3);
    expect(new Set(allocs.map((a) => a.studentId)).size).toBe(3);
    expect(new Set(allocs.map((a) => a.seatId)).size).toBe(3);
    expect(new Set(allocs.map((a) => a.classroomId)).size).toBe(1);
    expect(allocs.every((a) => a.classroomId === room)).toBe(true);

    const report = res.body.result.run.validationReport;
    expect(report.status).toBe('VALID');
    expect(report.assigned).toBe(3);
    expect(report.unassigned).toBe(0);

    const exam = await prisma.exam.findUnique({ where: { id: examId } });
    expect(exam?.seatingStatus).toBe('VALIDATED');
    expect(exam?.isStale).toBe(false);

    const saved = await prisma.seatingRun.findUnique({ where: { id: runId } });
    expect((saved?.validationReport as { status: string }).status).toBe('VALID');
    expect(typeof (saved?.stats as { timeMs: number }).timeMs).toBe('number');
    expect(typeof saved?.totalPenalty).toBe('number');

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: examId, action: 'seating.generate' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(superAdmin.id);
  });

  it('insufficient seats -> 422 with structured failure, FAILED run persisted, no allocations', async () => {
    const small = await mkRoom(`SEAT-S${suffix}`, 2);
    const examId = await mkExam();
    const ids = await mkStudents(6);
    await registerBulk(examId, ids);

    const res = await generate(examId, { roomIds: [small], seed: 'seed-2' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNPROCESSABLE_ENTITY');
    expect(res.body.error.message).toContain('Additional seats required: 4');

    const details = res.body.error.details;
    expect(typeof details.runId).toBe('string');
    expect(details.failure.code).toBe('INSUFFICIENT_SEATS');
    expect(details.failure.details.required).toBe(6);
    expect(details.failure.details.available).toBe(2);
    expect(details.failure.details.additionalRequired).toBe(4);

    const run = await prisma.seatingRun.findUnique({ where: { id: details.runId } });
    expect(run?.status).toBe('FAILED');
    expect((run?.failure as { code: string }).code).toBe('INSUFFICIENT_SEATS');
    expect(await prisma.seatingAllocation.count({ where: { examId } })).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: examId, action: 'seating.generate_failed' },
    });
    expect(audit).not.toBeNull();
  });

  it('no eligible students -> 422 NO_ELIGIBLE_STUDENTS with a FAILED run', async () => {
    const room = await mkRoom(`SEAT-E${suffix}`, 4);
    const examId = await mkExam();
    const res = await generate(examId, { roomIds: [room] });
    expect(res.status).toBe(422);
    expect(res.body.error.details.failure.code).toBe('NO_ELIGIBLE_STUDENTS');
    const run = await prisma.seatingRun.findUnique({ where: { id: res.body.error.details.runId } });
    expect(run?.status).toBe('FAILED');
  });

  it('exact fit: students == seats succeeds', async () => {
    const room = await mkRoom(`SEAT-F${suffix}`, 4);
    const examId = await mkExam();
    const ids = await mkStudents(4);
    await registerBulk(examId, ids);
    const res = await generate(examId, { roomIds: [room], seed: 'exact' });
    expect(res.status).toBe(200);
    const allocs = await allocations(examId);
    expect(allocs.length).toBe(4);
    expect(new Set(allocs.map((a) => a.seatId)).size).toBe(4);
  });

  it('unavailable room is excluded from generation', async () => {
    const available = await mkRoom(`SEAT-A${suffix}`, 2);
    const unavailable = await mkRoom(`SEAT-U${suffix}`, 10, 'UNAVAILABLE');

    const okExam = await mkExam();
    const okIds = await mkStudents(2);
    await registerBulk(okExam, okIds);
    const ok = await generate(okExam, { roomIds: [available, unavailable], seed: 'unavail-1' });
    expect(ok.status).toBe(200);
    expect((await allocations(okExam)).every((a) => a.classroomId === available)).toBe(true);

    const bigExam = await mkExam();
    const bigIds = await mkStudents(5);
    await registerBulk(bigExam, bigIds);
    const big = await generate(bigExam, { roomIds: [available, unavailable], seed: 'unavail-2' });
    expect(big.status).toBe(422);
    expect(big.body.error.details.failure.details.available).toBe(2);
    expect(big.body.error.details.failure.details.additionalRequired).toBe(3);
  });

  it('rooms used by a clashing exam plan are excluded', async () => {
    const clashDate = '2026-11-25';
    const shared = await mkRoom(`SEAT-C1${suffix}`, 4);
    const free = await mkRoom(`SEAT-C2${suffix}`, 6);

    const examA = await mkExam({ date: clashDate });
    await registerBulk(examA, await mkStudents(3));
    const a = await generate(examA, { roomIds: [shared], seed: 'clash-a' });
    expect(a.status).toBe(200);

    const examB = await mkExam({ date: clashDate });
    await registerBulk(examB, await mkStudents(4));
    const b = await generate(examB, { roomIds: [shared, free], seed: 'clash-b' });
    expect(b.status).toBe(200);
    const allocsB = await allocations(examB);
    expect(allocsB.length).toBe(4);
    expect(allocsB.every((x) => x.classroomId === free)).toBe(true);
  });

  it('regenerating supersedes the previous run (one active run remains)', async () => {
    const room = await mkRoom(`SEAT-RG${suffix}`, 4);
    const examId = await mkExam();
    await registerBulk(examId, await mkStudents(2));

    const g1 = await generate(examId, { roomIds: [room], seed: 'a' });
    expect(g1.status).toBe(200);
    const r1 = g1.body.result.run.id as string;

    const g2 = await request(app)
      .post(`/api/v1/seating/exams/${examId}/regenerate-seating`)
      .set(auth(superToken))
      .send({ roomIds: [room], seed: 'b' });
    expect(g2.status).toBe(200);
    const r2 = g2.body.result.run.id as string;
    expect(r2).not.toBe(r1);

    expect((await prisma.seatingRun.findUnique({ where: { id: r1 } }))?.status).toBe('SUPERSEDED');
    const active = await prisma.seatingRun.findMany({
      where: { examId, status: { in: ['DRAFT', 'VALIDATED'] } },
    });
    expect(active.length).toBe(1);
    expect((await prisma.seatingRun.findUnique({ where: { id: r2 } }))?.seed).toBe('b');

    const audit = await prisma.auditLog.findFirst({ where: { entityId: examId, action: 'seating.regenerate' } });
    expect(audit).not.toBeNull();
  });
});

describe('Phase 7: seating read & validation endpoints', () => {
  it('GET seating, GET validate and GET runs return the stored plan', async () => {
    const room = await mkRoom(`SEAT-G${suffix}`, 4);
    const examId = await mkExam();
    await registerBulk(examId, await mkStudents(2));
    expect((await generate(examId, { roomIds: [room], seed: 'g1' })).status).toBe(200);

    const seating = await request(app).get(`/api/v1/seating/exams/${examId}/seating`).set(auth(superToken));
    expect(seating.status).toBe(200);
    expect(seating.body.run.status).toBe('VALIDATED');
    expect(seating.body.allocations.length).toBe(2);
    expect(seating.body.allocations[0]).toHaveProperty('rollNumber');
    expect(seating.body.allocations[0]).toHaveProperty('benchNo');
    expect(seating.body.allocations[0]).toHaveProperty('roomNumber');

    const validate = await request(app)
      .get(`/api/v1/seating/exams/${examId}/seating/validate`)
      .set(auth(superToken));
    expect(validate.status).toBe(200);
    expect(validate.body.status).toBe('VALID');
    expect(validate.body.eligibleCount).toBe(2);
    expect(validate.body.seatedCount).toBe(2);
    expect(validate.body.suggestion).toBeNull();

    const runs = await request(app).get(`/api/v1/seating/exams/${examId}/seating/runs`).set(auth(superToken));
    expect(runs.status).toBe(200);
    expect(runs.body.runs.length).toBe(1);
    expect(runs.body.runs[0].status).toBe('VALIDATED');
    expect(runs.body.runs[0].allocationCount).toBe(2);

    const emptyExam = await mkExam();
    const noPlan = await request(app)
      .get(`/api/v1/seating/exams/${emptyExam}/seating/validate`)
      .set(auth(superToken));
    expect(noPlan.status).toBe(404);
  });

  it('a failed regeneration keeps the FAILED run in the history list', async () => {
    const room = await mkRoom(`SEAT-H${suffix}`, 4);
    const examId = await mkExam();
    await registerBulk(examId, await mkStudents(2));
    expect((await generate(examId, { roomIds: [room], seed: 'h1' })).status).toBe(200);

    const fail = await generate(examId, { roomIds: [randomUUID()], seed: 'h2' });
    expect(fail.status).toBe(422);
    expect(fail.body.error.details.failure.code).toBe('NO_AVAILABLE_ROOMS');

    const runs = await request(app).get(`/api/v1/seating/exams/${examId}/seating/runs`).set(auth(superToken));
    expect(runs.body.runs.length).toBe(2);
    const statuses = runs.body.runs.map((r: { status: string }) => r.status);
    expect(statuses).toContain('VALIDATED');
    expect(statuses).toContain('FAILED');
    const failed = runs.body.runs.find((r: { status: string }) => r.status === 'FAILED');
    expect(failed.failure.code).toBe('NO_AVAILABLE_ROOMS');
    expect(failed.allocationCount).toBe(0);
  });
});

describe('Phase 7: stale-plan detection', () => {
  it('student added after generation -> STALE report, publish blocked, regenerate fixes it', async () => {
    const room = await mkRoom(`SEAT-ST1${suffix}`, 6);
    const examId = await mkExam();
    const ids = await mkStudents(3);
    await registerBulk(examId, ids);
    expect((await generate(examId, { roomIds: [room], seed: 'st1' })).status).toBe(200);

    const added = await mkStudent();
    await register(examId, added);
    expect((await prisma.exam.findUnique({ where: { id: examId } }))?.isStale).toBe(true);

    const validate = await request(app)
      .get(`/api/v1/seating/exams/${examId}/seating/validate`)
      .set(auth(superToken));
    expect(validate.body.status).toBe('STALE');
    expect(validate.body.addedAfterGeneration.map((s: { studentId: string }) => s.studentId)).toContain(added);
    expect(validate.body.suggestion).toContain('Regenerate');

    const pub = await request(app).post(`/api/v1/seating/exams/${examId}/publish`).set(auth(superToken));
    expect(pub.status).toBe(409);
    expect(pub.body.error.message).toContain('stale');
    expect(pub.body.error.message).toContain('Regenerate');

    const regen = await request(app)
      .post(`/api/v1/seating/exams/${examId}/regenerate-seating`)
      .set(auth(superToken))
      .send({ roomIds: [room], seed: 'st1b' });
    expect(regen.status).toBe(200);

    const after = await request(app)
      .get(`/api/v1/seating/exams/${examId}/seating/validate`)
      .set(auth(superToken));
    expect(after.body.status).toBe('VALID');
    expect(after.body.seatedCount).toBe(4);
    expect((await request(app).post(`/api/v1/seating/exams/${examId}/publish`).set(auth(superToken))).status).toBe(200);
  });

  it('student removed after generation -> STALE report, publish blocked', async () => {
    const room = await mkRoom(`SEAT-ST2${suffix}`, 6);
    const examId = await mkExam();
    const ids = await mkStudents(3);
    await registerBulk(examId, ids);
    expect((await generate(examId, { roomIds: [room], seed: 'st2' })).status).toBe(200);

    const patch = await request(app)
      .patch(`/api/v1/exams/${examId}/registrations/${ids[2]}`)
      .set(auth(superToken))
      .send({ status: 'REMOVED' });
    expect(patch.status).toBe(200);
    expect(patch.body.examIsStale).toBe(true);

    const validate = await request(app)
      .get(`/api/v1/seating/exams/${examId}/seating/validate`)
      .set(auth(superToken));
    expect(validate.body.status).toBe('STALE');
    expect(validate.body.removedButSeated.map((s: { studentId: string }) => s.studentId)).toContain(ids[2]);

    const pub = await request(app).post(`/api/v1/seating/exams/${examId}/publish`).set(auth(superToken));
    expect(pub.status).toBe(409);
  });

  it('disabled room/seats since generation -> STALE report, publish blocked', async () => {
    const room = await mkRoom(`SEAT-ST3${suffix}`, 4);
    const examId = await mkExam();
    await registerBulk(examId, await mkStudents(2));
    expect((await generate(examId, { roomIds: [room], seed: 'st3' })).status).toBe(200);

    const allocs = await allocations(examId);
    await pool.query(`UPDATE seats SET status = 'DISABLED' WHERE id = ANY($1::uuid[])`, [
      allocs.map((a) => a.seatId),
    ]);
    await pool.query(`UPDATE classrooms SET status = 'UNAVAILABLE' WHERE id = $1`, [room]);

    const validate = await request(app)
      .get(`/api/v1/seating/exams/${examId}/seating/validate`)
      .set(auth(superToken));
    expect(validate.body.status).toBe('STALE');
    expect(validate.body.disabledSeats.length).toBe(2);
    expect(validate.body.disabledRooms.map((r: { classroomId: string }) => r.classroomId)).toContain(room);

    const pub = await request(app).post(`/api/v1/seating/exams/${examId}/publish`).set(auth(superToken));
    expect(pub.status).toBe(409);
  });

  it('schedule change after generation sets isStale and blocks publishing', async () => {
    const room = await mkRoom(`SEAT-ST4${suffix}`, 4);
    const examId = await mkExam();
    await registerBulk(examId, await mkStudents(2));
    expect((await generate(examId, { roomIds: [room], seed: 'st4' })).status).toBe(200);

    const upd = await request(app)
      .put(`/api/v1/exams/${examId}`)
      .set(auth(superToken))
      .send({ startTime: '13:00', endTime: '16:00' });
    expect(upd.status).toBe(200);
    expect((await prisma.exam.findUnique({ where: { id: examId } }))?.isStale).toBe(true);

    const pub = await request(app).post(`/api/v1/seating/exams/${examId}/publish`).set(auth(superToken));
    expect(pub.status).toBe(409);
    expect(pub.body.error.details.scheduleChanged).toBe(true);
  });
});

describe('Phase 7: publish / unpublish', () => {
  it('publish stamps the run and allocations, blocks duplicates, and enforces immutability', async () => {
    const room = await mkRoom(`SEAT-PB${suffix}`, 4);
    const examId = await mkExam();
    await registerBulk(examId, await mkStudents(3));
    const gen = await generate(examId, { roomIds: [room], seed: 'pub' });
    expect(gen.status).toBe(200);
    const runId = gen.body.result.run.id as string;

    const pub = await request(app).post(`/api/v1/seating/exams/${examId}/publish`).set(auth(superToken));
    expect(pub.status).toBe(200);
    expect(pub.body.published).toBe(true);

    const exam = await prisma.exam.findUnique({ where: { id: examId } });
    expect(exam?.seatingStatus).toBe('PUBLISHED');
    const run = await prisma.seatingRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('PUBLISHED');
    expect(run?.publishedAt).not.toBeNull();
    expect(run?.publishedBy).toBe(superAdmin.id);
    const allocs = await prisma.seatingAllocation.findMany({ where: { runId } });
    expect(allocs.every((a) => a.publishedAt !== null)).toBe(true);

    const again = await request(app).post(`/api/v1/seating/exams/${examId}/publish`).set(auth(superToken));
    expect(again.status).toBe(409);

    const genOnPublished = await generate(examId, { roomIds: [room], seed: 'x' });
    expect(genOnPublished.status).toBe(409);
    expect(genOnPublished.body.error.message).toContain('PUBLISHED');

    await expect(pool.query(`UPDATE seating_allocations SET published_at = published_at WHERE run_id = $1`, [runId]))
      .rejects.toMatchObject({ code: SQLSTATE.INSUFFICIENT_PRIVILEGE });
    await expect(pool.query(`UPDATE seating_runs SET seed = seed WHERE id = $1`, [runId])).rejects.toMatchObject({
      code: SQLSTATE.INSUFFICIENT_PRIVILEGE,
    });

    const audit = await prisma.auditLog.findFirst({ where: { entityId: examId, action: 'seating.publish' } });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(superAdmin.id);
  });

  it('publish without a plan returns 409', async () => {
    const examId = await mkExam();
    const res = await request(app).post(`/api/v1/seating/exams/${examId}/publish`).set(auth(superToken));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('No VALIDATED seating run');
  });

  it('unpublish (SUPER_ADMIN + reason) makes the plan editable again and is audit logged', async () => {
    const room = await mkRoom(`SEAT-UP${suffix}`, 4);
    const examId = await mkExam();
    await registerBulk(examId, await mkStudents(2));
    expect((await generate(examId, { roomIds: [room], seed: 'up' })).status).toBe(200);
    expect((await request(app).post(`/api/v1/seating/exams/${examId}/publish`).set(auth(superToken))).status).toBe(200);

    const byExamAdmin = await request(app)
      .post(`/api/v1/seating/exams/${examId}/unpublish`)
      .set(auth(examAdminToken))
      .send({ reason: 'Exam admin should not be able to unpublish' });
    expect(byExamAdmin.status).toBe(403);

    const noReason = await request(app)
      .post(`/api/v1/seating/exams/${examId}/unpublish`)
      .set(auth(superToken))
      .send({ reason: 'ab' });
    expect(noReason.status).toBe(400);

    const un = await request(app)
      .post(`/api/v1/seating/exams/${examId}/unpublish`)
      .set(auth(superToken))
      .send({ reason: 'Correcting room allocation for demo' });
    expect(un.status).toBe(200);

    const exam = await prisma.exam.findUnique({ where: { id: examId } });
    expect(exam?.seatingStatus).toBe('VALIDATED');
    expect(exam?.isStale).toBe(false);

    const run = await prisma.seatingRun.findFirst({ where: { examId, status: 'VALIDATED' } });
    expect(run?.publishedAt).toBeNull();
    const allocs = await prisma.seatingAllocation.findMany({ where: { examId } });
    expect(allocs.every((a) => a.publishedAt === null)).toBe(true);

    const again = await request(app)
      .post(`/api/v1/seating/exams/${examId}/unpublish`)
      .set(auth(superToken))
      .send({ reason: 'Trying once more to unpublish' });
    expect(again.status).toBe(409);

    const audit = await prisma.auditLog.findFirst({ where: { entityId: examId, action: 'seating.unpublish' } });
    expect(audit).not.toBeNull();
    expect((audit?.metadata as { reason: string }).reason).toBe('Correcting room allocation for demo');
  });
});

describe('Phase 7: regenerate a PUBLISHED plan', () => {
  it('EXAM_ADMIN is rejected; SUPER_ADMIN needs reason + confirm and gets a new VALIDATED run', async () => {
    const room = await mkRoom(`SEAT-RP${suffix}`, 4);
    const examId = await mkExam();
    await registerBulk(examId, await mkStudents(3));
    expect((await generate(examId, { roomIds: [room], seed: 'rp' })).status).toBe(200);
    const pub = await request(app).post(`/api/v1/seating/exams/${examId}/publish`).set(auth(superToken));
    expect(pub.status).toBe(200);
    const publishedRunId = (
      await prisma.seatingRun.findFirst({ where: { examId, status: 'PUBLISHED' }, select: { id: true } })
    )?.id as string;

    const byExamAdmin = await request(app)
      .post(`/api/v1/seating/exams/${examId}/regenerate-seating`)
      .set(auth(examAdminToken))
      .send({ roomIds: [room], seed: 'rp2', reason: 'exam admin attempt', confirm: true });
    expect(byExamAdmin.status).toBe(403);

    const noReason = await request(app)
      .post(`/api/v1/seating/exams/${examId}/regenerate-seating`)
      .set(auth(superToken))
      .send({ roomIds: [room], seed: 'rp3' });
    expect(noReason.status).toBe(400);

    const noConfirm = await request(app)
      .post(`/api/v1/seating/exams/${examId}/regenerate-seating`)
      .set(auth(superToken))
      .send({ roomIds: [room], seed: 'rp3', reason: 'fixing bench clashes' });
    expect(noConfirm.status).toBe(400);

    const ok = await request(app)
      .post(`/api/v1/seating/exams/${examId}/regenerate-seating`)
      .set(auth(superToken))
      .send({ roomIds: [room], seed: 'rp-ok', reason: 'fixing bench clashes for demo', confirm: true });
    expect(ok.status).toBe(200);
    expect(ok.body.result.run.status).toBe('VALIDATED');
    expect(ok.body.result.run.seed).toBe('rp-ok');

    expect((await prisma.seatingRun.findUnique({ where: { id: publishedRunId } }))?.status).toBe('SUPERSEDED');
    expect((await prisma.exam.findUnique({ where: { id: examId } }))?.seatingStatus).toBe('VALIDATED');

    const unpublishAudit = await prisma.auditLog.findFirst({
      where: { entityId: examId, action: 'seating.unpublish' },
    });
    expect((unpublishAudit?.metadata as { reason: string }).reason).toContain('regenerate:');
    const regenAudit = await prisma.auditLog.findFirst({ where: { entityId: examId, action: 'seating.regenerate' } });
    expect(regenAudit).not.toBeNull();
  });
});

describe('Phase 7: concurrency, rollback', () => {
  it('two simultaneous generations for the same exam -> the second gets 409', async () => {
    const room = await mkRoom(`SEAT-CC${suffix}`, 4);
    const examId = await mkExam();
    await registerBulk(examId, await mkStudents(2));

    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [examId]);
      const blocked = await generate(examId, { roomIds: [room], seed: 'locked' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('CONFLICT');
      expect(blocked.body.error.message).toContain('already in progress');
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [examId]);
      client.release();
    }

    const after = await generate(examId, { roomIds: [room], seed: 'unlocked' });
    expect(after.status).toBe(200);
    expect(await prisma.seatingAllocation.count({ where: { examId } })).toBe(2);
  });

  it('a failure mid-transaction rolls back everything (no partial runs or allocations)', async () => {
    const room = await mkRoom(`SEAT-RB${suffix}`, 4);
    const examId = await mkExam();
    await registerBulk(examId, await mkStudents(3));

    await pool.query(
      `CREATE OR REPLACE FUNCTION test_raise_fail() RETURNS trigger LANGUAGE plpgsql AS $fn$
       BEGIN RAISE EXCEPTION 'injected allocation failure'; END $fn$`,
    );
    await pool.query(
      `CREATE TRIGGER trg_test_raise_fail BEFORE INSERT ON seating_allocations
       FOR EACH ROW WHEN (NEW.exam_id = '${examId}')
       EXECUTE FUNCTION test_raise_fail()`,
    );

    try {
      const res = await generate(examId, { roomIds: [room], seed: 'boom' });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(await prisma.seatingRun.count({ where: { examId } })).toBe(0);
      expect(await prisma.seatingAllocation.count({ where: { examId } })).toBe(0);
      const exam = await prisma.exam.findUnique({ where: { id: examId } });
      expect(exam?.seatingStatus).toBe('NOT_GENERATED');
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS trg_test_raise_fail ON seating_allocations`);
      await pool.query(`DROP FUNCTION IF EXISTS test_raise_fail()`);
    }

    const retry = await generate(examId, { roomIds: [room], seed: 'boom-ok' });
    expect(retry.status).toBe(200);
  });
});

describe('Phase 7: RBAC', () => {
  it('anonymous requests get 401 on the seating routes', async () => {
    await mkRoom(`SEAT-RB1${suffix}`, 4);
    const examId = await mkExam();
    // The guard runs before any plan exists, so no fixture plan is needed.
    expect((await request(app).post(`/api/v1/seating/exams/${examId}/generate-seating`).send({})).status).toBe(401);
    expect((await request(app).get(`/api/v1/seating/exams/${examId}/seating`)).status).toBe(401);
    expect((await request(app).post(`/api/v1/seating/exams/${examId}/publish`)).status).toBe(401);
    expect(
      (await request(app).post(`/api/v1/seating/exams/${examId}/unpublish`).send({ reason: 'anonymous' })).status,
    ).toBe(401);
  });

  it('EXAM_ADMIN can generate seating', async () => {
    const room = await mkRoom(`SEAT-RB2${suffix}`, 4);
    const examId = await mkExam();
    await registerBulk(examId, await mkStudents(2));
    const res = await generate(examId, { roomIds: [room], seed: 'ea-gen' }, examAdminToken);
    expect(res.status).toBe(200);
    expect(res.body.result.run.status).toBe('VALIDATED');
  });

  it('seating history: an admin reads any student history', async () => {
    const room = await mkRoom(`SEAT-SH${suffix}`, 4);
    const examId = await mkExam();
    const ids = await mkStudents(2);
    await registerBulk(examId, ids);
    expect((await generate(examId, { roomIds: [room], seed: 'hist' })).status).toBe(200);
    expect((await request(app).post(`/api/v1/seating/exams/${examId}/publish`).set(auth(superToken))).status).toBe(200);

    for (const studentId of ids) {
      const view = await request(app)
        .get(`/api/v1/seating/students/${studentId}/seating-history`)
        .set(auth(superToken));
      expect(view.status).toBe(200);
      expect(view.body.studentId).toBe(studentId);
      expect(view.body.history.length).toBeGreaterThanOrEqual(1);
      expect(view.body.history[0].examId).toBe(examId);
      expect(view.body.history[0].runStatus).toBe('PUBLISHED');
      expect(view.body.history[0]).toHaveProperty('benchNo');
    }

    // An EXAM_ADMIN may read history too, but an anonymous caller may not.
    const asExamAdmin = await request(app)
      .get(`/api/v1/seating/students/${ids[0]}/seating-history`)
      .set(auth(examAdminToken));
    expect(asExamAdmin.status).toBe(200);

    const anonymous = await request(app).get(`/api/v1/seating/students/${ids[0]}/seating-history`);
    expect(anonymous.status).toBe(401);
  });
});

describe('Phase 7: seating history across consecutive papers', () => {
  it('history depth 3 produces fewer repeats than the identical depth-0 baseline', async () => {
    const yearH = (await prisma.academicYear.create({ data: { name: `Hist Year ${suffix}`, code: `HY${suffix}` } })).id;
    const deptH = (await prisma.department.create({ data: { name: `Hist Dept ${suffix}`, code: `HD${suffix}` } })).id;
    const room1 = await mkRoom(`HIST-A${suffix}`, 12);
    const room2 = await mkRoom(`HIST-B${suffix}`, 12);
    const ids = await mkStudents(12, yearH, deptH);

    const p1 = await mkExam({ date: '2026-12-01', yearId: yearH });
    const p2 = await mkExam({ date: '2026-12-02', yearId: yearH });
    const p3 = await mkExam({ date: '2026-12-03', yearId: yearH });
    await registerBulk(p1, ids);
    await registerBulk(p2, ids);
    await registerBulk(p3, ids);

    const rooms = [room1, room2];

    // Paper 1 — no history.
    const g1 = await generate(p1, { roomIds: rooms, seed: 'hist', historyDepth: 0 });
    expect(g1.status).toBe(200);

    // Paper 2 baseline — same seed, history disabled => identical arrangement.
    const g2base = await generate(p2, { roomIds: rooms, seed: 'hist', historyDepth: 0 });
    expect(g2base.status).toBe(200);
    expect(g2base.body.result.run.validationReport.historyConsidered.enabled).toBe(false);
    const m1 = await seatMap(p1);
    const m2base = await seatMap(p2);
    const base = repeats(m1, m2base);
    expect(base.both).toBe(12);
    expect(base.sameSeat).toBe(12);
    expect(base.sameRoom).toBe(12);

    // Paper 2 with history: same seed, depth 3 => the engine must avoid Paper 1 seats.
    const g2hist = await request(app)
      .post(`/api/v1/seating/exams/${p2}/regenerate-seating`)
      .set(auth(superToken))
      .send({ roomIds: rooms, seed: 'hist', historyDepth: 3 });
    expect(g2hist.status).toBe(200);
    expect(g2hist.body.result.run.validationReport.historyConsidered.enabled).toBe(true);
    expect(g2hist.body.result.run.validationReport.historyConsidered.depth).toBe(3);
    const m2hist = await seatMap(p2);
    const treated = repeats(m1, m2hist);
    expect(treated.sameSeat).toBeLessThan(base.sameSeat);
    expect(treated.sameRoom).toBeLessThan(base.sameRoom);

    // Paper 3 — reads both previous papers.
    const g3 = await generate(p3, { roomIds: rooms, seed: 'hist', historyDepth: 3 });
    expect(g3.status).toBe(200);
    expect(g3.body.result.run.validationReport.historyConsidered.depth).toBe(3);
    const m3 = await seatMap(p3);
    const vsP2 = repeats(m2hist, m3);
    const vsP1 = repeats(m1, m3);
    expect(vsP2.both).toBe(12);
    expect(vsP2.sameSeat).toBeLessThan(12);
    expect(vsP1.sameSeat).toBeLessThan(base.sameSeat);
  }, 60_000);
});
