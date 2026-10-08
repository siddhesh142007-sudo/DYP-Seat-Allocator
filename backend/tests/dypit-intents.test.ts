import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestPool, truncateAll } from './helpers/db.js';
import { createTestUser } from './helpers/auth.js';
import { createApp } from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/db/prisma.js';

const PW = 'IntentSecret123!';

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let adminToken: string;
let superToken: string;
let studentToken: string;
let yearId: string;
let aidsDept: string;
let ceDept: string;
let room706: string;
let examId: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Creates a room with `benches` benches, returning its id. */
async function mkRoom(roomNumber: string, benches: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO classrooms (id, room_number, building, floor, status, capacity)
     VALUES ($1, $2, 'B', '7', 'AVAILABLE', $3)`,
    [id, roomNumber, benches],
  );
  await pool.query(
    `INSERT INTO seats (id, classroom_id, bench_number, status, row_no, col_no)
     SELECT gen_random_uuid(), $1, g, 'AVAILABLE', g, 1 FROM generate_series(1, $2) g`,
    [id, benches],
  );
  return id;
}

/** Creates a cohort of students with DYPIT roll numbers. */
async function mkCohort(opts: {
  yearCode: 'FE' | 'SE' | 'TE' | 'BE';
  branchCode: string;
  division: string;
  from: number;
  to: number;
  deptId: string;
}): Promise<string[]> {
  const ids: string[] = [];
  for (let n = opts.from; n <= opts.to; n++) {
    const roll = `${opts.yearCode}-${opts.branchCode}-${opts.division}_${String(n).padStart(2, '0')}`;
    const id = randomUUID();
    await pool.query(
      `INSERT INTO students (id, roll_number, name, division, year_code, status, academic_year_id, department_id)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7)`,
      [id, roll, `Student ${roll}`, opts.division, opts.yearCode, yearId, opts.deptId],
    );
    ids.push(id);
  }
  return ids;
}

beforeAll(async () => {
  pool = createTestPool(5);
  await truncateAll(pool);
  app = createApp();

  const superAdmin = await createTestUser(pool, { role: 'SUPER_ADMIN', password: PW });
  const examAdmin = await createTestUser(pool, { role: 'EXAM_ADMIN', password: PW });
  const student = await createTestUser(pool, { role: 'STUDENT', password: PW });
  superToken = (await request(app).post('/api/v1/auth/login').send({ identifier: superAdmin.email, password: PW })).body
    .accessToken;
  adminToken = (await request(app).post('/api/v1/auth/login').send({ identifier: examAdmin.email, password: PW })).body
    .accessToken;
  studentToken = (await request(app).post('/api/v1/auth/login').send({ identifier: student.email, password: PW })).body
    .accessToken;

  yearId = randomUUID();
  await pool.query(`INSERT INTO academic_years (id, name, code, order_index, status) VALUES ($1,'AY','AY1',1,'ACTIVE')`, [yearId]);
  aidsDept = randomUUID();
  ceDept = randomUUID();
  await pool.query(`INSERT INTO departments (id, name, code, status, sanctioned_intake) VALUES ($1,'AI & DS','AIDS','ACTIVE',180)`, [aidsDept]);
  await pool.query(`INSERT INTO departments (id, name, code, status, sanctioned_intake) VALUES ($1,'Computer Engg','CE','ACTIVE',240)`, [ceDept]);

  room706 = await mkRoom(`706-${randomUUID().slice(0, 6)}`, 60);
  examId = randomUUID();
  await pool.query(
    `INSERT INTO exams (id, subject, exam_date, start_time, end_time, academic_year_id)
     VALUES ($1, 'Data Structures', '2026-12-01', '09:00', '12:00', $2)`,
    [examId, yearId],
  );

  // 45 students in SE-AIDS-C, plus 20 in SE-CE-A so branch filtering matters.
  await mkCohort({ yearCode: 'SE', branchCode: 'AIDS', division: 'C', from: 1, to: 45, deptId: aidsDept });
  await mkCohort({ yearCode: 'SE', branchCode: 'CE', division: 'A', from: 1, to: 20, deptId: ceDept });
}, 60_000);

afterAll(async () => {
  await disconnectPrisma();
  await pool.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM allocation_intents');
});

const baseIntent = (over: Record<string, unknown> = {}) => ({
  classroomId: room706,
  yearCode: 'SE',
  branchCode: 'AIDS',
  division: 'C',
  fromSerial: 1,
  toSerial: 45,
  ...over,
});

describe('GET /dypit/cohorts', () => {
  it('lists distinct cohorts with their serial bounds', async () => {
    const res = await request(app).get('/api/v1/dypit/cohorts').set(auth(adminToken));
    expect(res.status).toBe(200);
    const aids = res.body.cohorts.find(
      (c: { yearCode: string; branchCode: string; division: string }) =>
        c.yearCode === 'SE' && c.branchCode === 'AIDS' && c.division === 'C',
    );
    expect(aids).toMatchObject({ count: 45, minSerial: 1, maxSerial: 45 });
  });

  it('requires admin (401 anon, 403 student)', async () => {
    expect((await request(app).get('/api/v1/dypit/cohorts')).status).toBe(401);
    expect((await request(app).get('/api/v1/dypit/cohorts').set(auth(studentToken))).status).toBe(403);
  });
});

describe('POST /dypit/preview-range', () => {
  it('resolves the exact students in a range, in serial order', async () => {
    const res = await request(app)
      .post('/api/v1/dypit/preview-range')
      .set(auth(adminToken))
      .send({ yearCode: 'SE', branchCode: 'AIDS', division: 'C', fromSerial: 1, toSerial: 5 });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(5);
    expect(res.body.students.map((s: { serial: number }) => s.serial)).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles serials past 99 numerically', async () => {
    await mkCohort({ yearCode: 'SE', branchCode: 'AIDS', division: 'D', from: 98, to: 102, deptId: aidsDept });
    const res = await request(app)
      .post('/api/v1/dypit/preview-range')
      .set(auth(adminToken))
      .send({ yearCode: 'SE', branchCode: 'AIDS', division: 'D', fromSerial: 98, toSerial: 102 });
    expect(res.body.count).toBe(5);
    expect(res.body.students.map((s: { serial: number }) => s.serial)).toEqual([98, 99, 100, 101, 102]);
  });

  it('400s on an inverted range', async () => {
    const res = await request(app)
      .post('/api/v1/dypit/preview-range')
      .set(auth(adminToken))
      .send({ yearCode: 'SE', branchCode: 'AIDS', division: 'C', fromSerial: 45, toSerial: 1 });
    expect(res.status).toBe(400);
  });

  it('rejects a lowercase division by normalising it', async () => {
    const res = await request(app)
      .post('/api/v1/dypit/preview-range')
      .set(auth(adminToken))
      .send({ yearCode: 'SE', branchCode: 'AIDS', division: 'c', fromSerial: 1, toSerial: 5 });
    expect(res.status).toBe(200);
    expect(res.body.students).toHaveLength(5);
  });
});

describe('POST /dypit/exams/:examId/intents', () => {
  it('creates a range -> room block', async () => {
    const res = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent());
    expect(res.status).toBe(201);
    expect(res.body.intent).toMatchObject({
      yearCode: 'SE',
      branchCode: 'AIDS',
      division: 'C',
      fromSerial: 1,
      toSerial: 45,
      studentCount: 45,
      strictRollOrder: false,
    });
  });

  it('rejects a range that matches no students', async () => {
    const res = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ division: 'Z', toSerial: 5 }));
    expect(res.status).toBe(422);
    expect(res.body.error.details.code).toBe('EMPTY_RANGE');
  });

  it('auto-places a block in the next free bench window when no offset is given', async () => {
    const first = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ fromSerial: 1, toSerial: 20 }));
    expect(first.body.intent.seatOffset).toBe(1);
    const second = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ fromSerial: 21, toSerial: 40 }));
    // 20 benches were taken, so the next block starts at bench 21.
    expect(second.body.intent.seatOffset).toBe(21);
  });

  it('honours an explicit seat offset', async () => {
    // 20 students, 31 benches usable from offset 30 in a 60-bench room.
    const res = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ fromSerial: 1, toSerial: 20, seatOffset: 30 }));
    expect(res.status).toBe(201);
    expect(res.body.intent.seatOffset).toBe(30);
  });

  it('rejects an offset that leaves too few benches', async () => {
    const res = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ seatOffset: 30 }));
    expect(res.status).toBe(422);
    expect(res.body.error.details.code).toBe('ROOM_TOO_SMALL');
  });

  it('rejects a block larger than the room', async () => {
    const small = await mkRoom(`small-${randomUUID().slice(0, 6)}`, 10);
    const res = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ classroomId: small }));
    expect(res.status).toBe(422);
    expect(res.body.error.details.code).toBe('ROOM_TOO_SMALL');
    expect(res.body.error.message).toContain('10');
  });

  it('rejects an overlapping serial range for the same cohort', async () => {
    await request(app).post(`/api/v1/dypit/exams/${examId}/intents`).set(auth(adminToken)).send(baseIntent());
    const res = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ fromSerial: 40, toSerial: 60 }));
    expect(res.status).toBe(422);
    expect(res.body.error.details.code).toBe('RANGE_OVERLAP');
  });

  it('allows adjacent, non-overlapping ranges', async () => {
    const first = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ fromSerial: 1, toSerial: 20 }));
    expect(first.status).toBe(201);
    const second = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ fromSerial: 21, toSerial: 40 }));
    expect(second.status).toBe(201);
  });

  it('allows the same serial range for a different division', async () => {
    await mkCohort({ yearCode: 'SE', branchCode: 'AIDS', division: 'A', from: 1, to: 10, deptId: aidsDept });
    const one = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent());
    expect(one.status).toBe(201);
    const two = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ division: 'A', fromSerial: 1, toSerial: 10 }));
    expect(two.status).toBe(201);
  });

  it('rejects a half-specified grid', async () => {
    const res = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ rowCount: 5 }));
    expect(res.status).toBe(400);
  });

  it('accepts a full row x col grid', async () => {
    const res = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ rowCount: 5, colCount: 9 }));
    expect(res.status).toBe(201);
    expect(res.body.intent).toMatchObject({ rowCount: 5, colCount: 9 });
  });

  it('rejects an unknown room', async () => {
    const res = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ classroomId: randomUUID() }));
    expect(res.status).toBe(404);
  });

  it('rejects an unknown exam', async () => {
    const res = await request(app)
      .post(`/api/v1/dypit/exams/${randomUUID()}/intents`)
      .set(auth(adminToken))
      .send(baseIntent());
    expect(res.status).toBe(404);
  });

  it('rejects a division that is not 1-2 letters', async () => {
    const res = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ division: 'CCC' }));
    expect(res.status).toBe(400);
  });

  it('normalises a lowercase division letter to upper case', async () => {
    const res = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ division: 'c' }));
    expect(res.status).toBe(201);
    expect(res.body.intent.division).toBe('C');
  });

  it('403s a student and 401s an anonymous caller', async () => {
    expect(
      (await request(app).post(`/api/v1/dypit/exams/${examId}/intents`).set(auth(studentToken)).send(baseIntent()))
        .status,
    ).toBe(403);
    expect((await request(app).post(`/api/v1/dypit/exams/${examId}/intents`).send(baseIntent())).status).toBe(401);
  });

  it('writes an audit entry', async () => {
    const res = await request(app).post(`/api/v1/dypit/exams/${examId}/intents`).set(auth(superToken)).send(baseIntent());
    const intentId = res.body.intent.id;
    // Query by this intent's id: earlier tests in this file also wrote
    // intent.create rows, and findFirst without ordering can return any of them.
    const audit = await prisma.auditLog.findFirst({ where: { action: 'intent.create', entityId: intentId } });
    expect(audit).not.toBeNull();
    expect(audit!.entityType).toBe('allocation_intent');
  });
});

describe('GET /dypit/exams/:examId/intents', () => {
  it('lists intents with resolved student counts', async () => {
    await request(app).post(`/api/v1/dypit/exams/${examId}/intents`).set(auth(adminToken)).send(baseIntent());
    const res = await request(app).get(`/api/v1/dypit/exams/${examId}/intents`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.intents).toHaveLength(1);
    expect(res.body.intents[0].studentCount).toBe(45);
  });

  it('returns an empty list when nothing is planned', async () => {
    const res = await request(app).get(`/api/v1/dypit/exams/${examId}/intents`).set(auth(adminToken));
    expect(res.body.intents).toEqual([]);
  });
});

describe('GET /dypit/exams/:examId/intents/plan', () => {
  it('summarises the whole plan before generating', async () => {
    await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ fromSerial: 1, toSerial: 20 }));
    const res = await request(app).get(`/api/v1/dypit/exams/${examId}/intents/plan`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ blockCount: 1, roomsUsed: 1, totalStudents: 20, allBlocksFit: true });
    expect(res.body.blocks[0].students).toHaveLength(20);
  });
});

describe('PATCH / DELETE intents', () => {
  it('updates a block', async () => {
    const created = await request(app).post(`/api/v1/dypit/exams/${examId}/intents`).set(auth(adminToken)).send(baseIntent());
    const id = created.body.intent.id;
    const res = await request(app)
      .patch(`/api/v1/dypit/exams/${examId}/intents/${id}`)
      .set(auth(adminToken))
      .send({ strictRollOrder: true, seatOffset: 3 });
    expect(res.status).toBe(200);
    expect(res.body.intent).toMatchObject({ strictRollOrder: true, seatOffset: 3 });
  });

  it('rejects an update that no longer fits the room', async () => {
    const small = await mkRoom(`tiny-${randomUUID().slice(0, 6)}`, 5);
    const created = await request(app)
      .post(`/api/v1/dypit/exams/${examId}/intents`)
      .set(auth(adminToken))
      .send(baseIntent({ classroomId: small, fromSerial: 1, toSerial: 5 }));
    expect(created.status).toBe(201);
    const res = await request(app)
      .patch(`/api/v1/dypit/exams/${examId}/intents/${created.body.intent.id}`)
      .set(auth(adminToken))
      .send({ toSerial: 45 });
    expect(res.status).toBe(422);
  });

  it('deletes a block', async () => {
    const created = await request(app).post(`/api/v1/dypit/exams/${examId}/intents`).set(auth(adminToken)).send(baseIntent());
    const res = await request(app)
      .delete(`/api/v1/dypit/exams/${examId}/intents/${created.body.intent.id}`)
      .set(auth(adminToken));
    expect(res.status).toBe(204);
    expect(await prisma.allocationIntent.count({ where: { examId } })).toBe(0);
  });

  it('404s an unknown intent', async () => {
    const res = await request(app)
      .delete(`/api/v1/dypit/exams/${examId}/intents/${randomUUID()}`)
      .set(auth(adminToken));
    expect(res.status).toBe(404);
  });
});

describe('intent editing is blocked once a plan exists', () => {
  it('refuses to delete an intent while a run exists', async () => {
    const created = await request(app).post(`/api/v1/dypit/exams/${examId}/intents`).set(auth(adminToken)).send(baseIntent());
    await pool.query(
      `INSERT INTO seating_runs (id, exam_id, seed, status, algorithm_version, config, total_penalty)
       VALUES ($1, $2, 'run-x', 'VALIDATED', 'v1', '{}'::jsonb, 0)`,
      [randomUUID(), examId],
    );
    const res = await request(app)
      .delete(`/api/v1/dypit/exams/${examId}/intents/${created.body.intent.id}`)
      .set(auth(adminToken));
    expect(res.status).toBe(409);
    await pool.query('DELETE FROM seating_runs');
  });
});