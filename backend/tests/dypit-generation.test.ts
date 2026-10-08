import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestPool, truncateAll } from './helpers/db.js';
import { createTestUser } from './helpers/auth.js';
import { createApp } from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/db/prisma.js';

const PW = 'DypitGen123!';

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let adminToken: string;
let studentToken: string;
let yearId: string;
let deptId: string;
let examId: string;
const rooms: Record<string, string> = {};

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function mkRoom(name: string, benches: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO classrooms (id, room_number, building, floor, status, capacity)
     VALUES ($1, $2, 'B', '7', 'AVAILABLE', $3)`,
    [id, `${name}-${suffix}`, benches],
  );
  await pool.query(
    `INSERT INTO seats (id, classroom_id, bench_number, status, row_no, col_no)
     SELECT gen_random_uuid(), $1, g, 'AVAILABLE', g, 1 FROM generate_series(1, $2) g`,
    [id, benches],
  );
  rooms[name] = id;
  return id;
}

async function mkCohort(division: string, from: number, to: number): Promise<void> {
  for (let n = from; n <= to; n++) {
    await pool.query(
      `INSERT INTO students (id, roll_number, name, division, year_code, status, academic_year_id, department_id)
       VALUES ($1, $2, $3, $4, 'SE', 'ACTIVE', $5, $6)`,
      [
        randomUUID(),
        `SE-AIDS-${division}_${String(n).padStart(2, '0')}`,
        `Student ${division}-${n}`,
        division,
        yearId,
        deptId,
      ],
    );
  }
}

async function addIntent(over: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(`/api/v1/dypit/exams/${examId}/intents`)
    .set(auth(adminToken))
    .send({
      classroomId: rooms.R706,
      yearCode: 'SE',
      branchCode: 'AIDS',
      division: 'C',
      fromSerial: 1,
      toSerial: 20,
      ...over,
    });
  return res;
}

async function generate(body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/v1/dypit/exams/${examId}/generate-from-intents`)
    .set(auth(adminToken))
    .send(body);
}

let suffix: string;

beforeAll(async () => {
  suffix = randomUUID().slice(0, 6);
  pool = createTestPool(5);
  await truncateAll(pool);
  app = createApp();

  const admin = await createTestUser(pool, { role: 'EXAM_ADMIN', password: PW });
  const student = await createTestUser(pool, { role: 'STUDENT', password: PW });
  adminToken = (await request(app).post('/api/v1/auth/login').send({ identifier: admin.email, password: PW })).body
    .accessToken;
  studentToken = (await request(app).post('/api/v1/auth/login').send({ identifier: student.email, password: PW })).body
    .accessToken;

  yearId = randomUUID();
  await pool.query(`INSERT INTO academic_years (id, name, code, order_index, status) VALUES ($1,'AY25','AY25',1,'ACTIVE')`, [yearId]);
  deptId = randomUUID();
  await pool.query(`INSERT INTO departments (id, name, code, status, sanctioned_intake) VALUES ($1,'AI & DS','AIDS','ACTIVE',180)`, [deptId]);

  await mkRoom('R706', 60);
  await mkRoom('R707', 60);

  examId = randomUUID();
  await pool.query(
    `INSERT INTO exams (id, subject, exam_date, start_time, end_time, academic_year_id)
     VALUES ($1, 'Data Structures', '2026-12-01', '09:00', '12:00', $2)`,
    [examId, yearId],
  );

  await mkCohort('C', 1, 30);
}, 60_000);

afterAll(async () => {
  await disconnectPrisma();
  await pool.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM allocation_intents');
  await pool.query('DELETE FROM seating_allocations');
  await pool.query('DELETE FROM seating_runs');
  await pool.query("UPDATE exams SET seating_status = 'NOT_GENERATED'");
});

describe('generateFromIntents', () => {
  it('refuses when the exam has no intents', async () => {
    const res = await generate();
    expect(res.status).toBe(422);
    expect(res.body.error.details.code).toBe('NO_INTENTS');
  });

  it('seats exactly the students in the declared range', async () => {
    await addIntent({ fromSerial: 1, toSerial: 20 });
    const res = await generate();
    expect(res.status).toBe(200);
    expect(res.body.result.totalSeated).toBe(20);
    expect(res.body.result.roomsUsed).toBe(1);
    expect(res.body.result.blocks[0]).toMatchObject({ students: 20, roomNumber: rooms.R706 ? expect.stringContaining('R706') : '' });

    const allocations = await prisma.seatingAllocation.findMany({ where: { examId } });
    expect(allocations).toHaveLength(20);
    // All in the chosen room.
    expect(new Set(allocations.map((a) => a.classroomId))).toEqual(new Set([rooms.R706]));
  });

  it('seats only students inside the roll range', async () => {
    await addIntent({ fromSerial: 5, toSerial: 9 });
    await generate();
    const allocations = await prisma.seatingAllocation.findMany({ where: { examId }, include: { student: true } });
    const serials = allocations
      .map((a) => Number(a.student.rollNumber.slice(a.student.rollNumber.lastIndexOf('_') + 1)))
      .sort((x, y) => x - y);
    expect(serials).toEqual([5, 6, 7, 8, 9]);
  });

  it('fills multiple blocks into their own rooms', async () => {
    await addIntent({ classroomId: rooms.R706, fromSerial: 1, toSerial: 15 });
    await addIntent({ classroomId: rooms.R707, fromSerial: 16, toSerial: 30 });
    const res = await generate();
    expect(res.status).toBe(200);
    expect(res.body.result.totalSeated).toBe(30);
    expect(res.body.result.roomsUsed).toBe(2);
    expect(res.body.result.blocks).toHaveLength(2);

    const byRoom = await prisma.seatingAllocation.groupBy({
      by: ['classroomId'],
      where: { examId },
      _count: { _all: true },
    });
    expect(byRoom.find((r) => r.classroomId === rooms.R706)!._count._all).toBe(15);
    expect(byRoom.find((r) => r.classroomId === rooms.R707)!._count._all).toBe(15);
  });

  it('respects seatOffset by starting the block later in the room', async () => {
    await addIntent({ fromSerial: 1, toSerial: 10, seatOffset: 20 });
    await generate();
    const allocations = await prisma.seatingAllocation.findMany({
      where: { examId },
      include: { seat: true },
    });
    const benches = allocations.map((a) => a.seat.benchNumber).sort((x, y) => x - y);
    expect(benches[0]).toBe(20);
    expect(benches).toHaveLength(10);
  });

  it('honours a rows x cols grid', async () => {
    await addIntent({ fromSerial: 1, toSerial: 12, rowCount: 3, colCount: 4 });
    const res = await generate();
    expect(res.status).toBe(200);
    expect(res.body.result.totalSeated).toBe(12);
  });

  it('seats in strict roll order when the block asks for it', async () => {
    await addIntent({ fromSerial: 1, toSerial: 10, strictRollOrder: true });
    await generate();
    const allocations = await prisma.seatingAllocation.findMany({
      where: { examId },
      include: { student: true, seat: true },
    });
    const ordered = allocations
      .map((a) => ({
        serial: Number(a.student.rollNumber.slice(a.student.rollNumber.lastIndexOf('_') + 1)),
        bench: a.seat.benchNumber,
      }))
      .sort((x, y) => x.bench - y.bench);
    expect(ordered.map((o) => o.serial)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('creates a VALIDATED run and marks the exam VALIDATED', async () => {
    await addIntent();
    await generate();
    const run = await prisma.seatingRun.findFirst({ where: { examId } });
    expect(run!.status).toBe('VALIDATED');
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
    expect(exam.seatingStatus).toBe('VALIDATED');
  });

  it('supersedes a previous plan when replace is passed', async () => {
    await addIntent();
    await generate();
    const second = await generate({ replace: true });
    expect(second.status).toBe(200);
    const runs = await prisma.seatingRun.findMany({ where: { examId } });
    expect(runs).toHaveLength(2);
    expect(runs.filter((r) => r.status === 'VALIDATED')).toHaveLength(1);
    expect(runs.filter((r) => r.status === 'SUPERSEDED')).toHaveLength(1);
    // Superseded runs keep their allocations on purpose (the comparison view
    // reads across runs), so scope the count to the active plan.
    const active = runs.find((r) => r.status === 'VALIDATED')!;
    expect(await prisma.seatingAllocation.count({ where: { runId: active.id } })).toBe(20);
  });

  it('refuses to overwrite an existing plan without replace', async () => {
    await addIntent();
    await generate();
    const res = await generate();
    expect(res.status).toBe(409);
    expect(res.body.error.details.code).toBe('PLAN_EXISTS');
  });

  it('is reproducible: the same seed yields the same seats', async () => {
    await addIntent();
    const seatsOfActiveRun = async () => {
      const run = await prisma.seatingRun.findFirstOrThrow({
        where: { examId, status: 'VALIDATED' },
      });
      return (await prisma.seatingAllocation.findMany({ where: { runId: run.id }, include: { seat: true } }))
        .map((a) => `${a.studentId}:${a.seat.benchNumber}`)
        .sort();
    };
    await generate({ seed: 'fixed-seed' });
    const first = await seatsOfActiveRun();
    await generate({ seed: 'fixed-seed', replace: true });
    const second = await seatsOfActiveRun();
    expect(second).toEqual(first);
  });

  it('moves students off the previous paper seats when regenerating', async () => {
    // Two shuffled papers should not repeat every seat.
    await addIntent({ fromSerial: 1, toSerial: 20 });
    await generate({ seed: 'paper-1' });
    const first = new Map(
      (await prisma.seatingAllocation.findMany({ where: { examId } })).map((a) => [a.studentId, a.seatId]),
    );
    await generate({ seed: 'paper-2', replace: true });
    const second = new Map(
      (await prisma.seatingAllocation.findMany({ where: { examId } })).map((a) => [a.studentId, a.seatId]),
    );
    const repeats = [...first].filter(([studentId, seatId]) => second.get(studentId) === seatId).length;
    expect(repeats).toBeLessThan(20);
  });

  it('keeps the same seat in strict roll order across papers', async () => {
    await addIntent({ fromSerial: 1, toSerial: 10, strictRollOrder: true });
    const seatIdsOfActiveRun = async () => {
      const run = await prisma.seatingRun.findFirstOrThrow({ where: { examId, status: 'VALIDATED' } });
      return (await prisma.seatingAllocation.findMany({ where: { runId: run.id } }))
        .map((a) => a.seatId)
        .sort();
    };
    await generate({ seed: 'p1' });
    const first = await seatIdsOfActiveRun();
    await generate({ seed: 'p2', replace: true });
    const second = await seatIdsOfActiveRun();
    expect(second).toEqual(first);
  });

  it('writes an audit entry', async () => {
    await addIntent();
    await generate();
    const audit = await prisma.auditLog.findFirst({ where: { action: 'intent.generate', entityId: examId } });
    expect(audit).not.toBeNull();
  });

  it('403s a student and 401s an anonymous caller', async () => {
    expect(
      (await request(app).post(`/api/v1/dypit/exams/${examId}/generate-from-intents`).set(auth(studentToken)).send({}))
        .status,
    ).toBe(403);
    expect((await request(app).post(`/api/v1/dypit/exams/${examId}/generate-from-intents`).send({})).status).toBe(401);
  });

  it('saves nothing when a block cannot be seated', async () => {
    // Range exists, but the room is switched to UNAVAILABLE after the intent exists.
    await addIntent({ fromSerial: 1, toSerial: 20 });
    await pool.query(`UPDATE classrooms SET status = 'UNAVAILABLE' WHERE id = $1`, [rooms.R706]);
    const res = await generate();
    expect(res.status).toBe(422);
    expect(await prisma.seatingAllocation.count({ where: { examId } })).toBe(0);
    expect(await prisma.seatingRun.count({ where: { examId } })).toBe(0);
    await pool.query(`UPDATE classrooms SET status = 'AVAILABLE' WHERE id = $1`, [rooms.R706]);
  });
});

describe('GET /dypit/exams/:examId/intents/explain', () => {
  it('describes each block without saving anything', async () => {
    await addIntent({ fromSerial: 1, toSerial: 10 });
    const res = await request(app)
      .get(`/api/v1/dypit/exams/${examId}/intents/explain`)
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.blocks[0]).toMatchObject({ students: 10, fits: true });
    expect(res.body.totalStudents).toBe(10);
    expect(await prisma.seatingAllocation.count({ where: { examId } })).toBe(0);
  });
});