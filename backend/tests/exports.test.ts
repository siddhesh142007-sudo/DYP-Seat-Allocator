import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestPool, truncateAll } from './helpers/db.js';
import { createTestUser, type TestUser } from './helpers/auth.js';
import { createApp } from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/db/prisma.js';

const PW = 'ExportSecret123!';
const DRAFT = 'DRAFT, NOT FOR DISTRIBUTION';

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let superAdmin: TestUser;
let superToken: string;
let examAdmin: TestUser;
let examAdminToken: string;
let studentToken: string;
const suffix = randomUUID().slice(0, 8);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

let yearId: string;
let deptA: string;
let deptB: string;
let deptACode: string;
let deptBCode: string;
let roomA: string;
let roomB: string;
let roomNumberA: string;
let roomNumberB: string;

let pubExamId: string;
let pubSubject: string;
let draftExamId: string;
let allRolls: string[] = [];
const studentIds: string[] = [];
let seatedStudentId = '';

let dayCounter = 0;

function nextDate(): string {
  dayCounter += 1;
  const day = ((dayCounter - 1) % 30) + 1;
  return `2026-12-${String(day).padStart(2, '0')}`;
}

async function login(identifier: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ identifier, password: PW });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function binaryGet(path: string, token: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const res = await request(app)
    .get(path)
    .set(auth(token))
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  return { status: res.status, headers: res.headers as Record<string, string>, body: res.body as Buffer };
}

function decodePdf(buf: Buffer): { text: string; pages: number } {
  const raw = buf.toString('latin1');
  const text = [...raw.matchAll(/<([0-9A-Fa-f]+)>/g)]
    .map((m) => Buffer.from(m[1], 'hex').toString('latin1'))
    .join('');
  const pages = (raw.match(/\/Type \/Page(?!s)/g) || []).length;
  return { text, pages };
}

async function loadWorkbook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

async function mkStudent(index: number, deptId: string, deptCode: string): Promise<{ id: string; roll: string }> {
  const roll = `EX-${deptCode}-${String(index).padStart(3, '0')}-${suffix}`;
  const s = await prisma.student.create({
    data: {
      rollNumber: roll,
      name: `Export Student ${index} ${suffix}`,
      status: 'ACTIVE',
      academicYearId: yearId,
      departmentId: deptId,
    },
  });
  return { id: s.id, roll };
}

async function mkRoom(roomNumber: string, benches: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO classrooms (id, room_number, building, floor, status, capacity) VALUES ($1, $2, 'Main', '1', 'AVAILABLE', $3)`,
    [id, roomNumber, benches],
  );
  await pool.query(
    `INSERT INTO seats (id, classroom_id, bench_number, status, row_no, col_no)
     SELECT gen_random_uuid(), $1, g, 'AVAILABLE', g, 1 FROM generate_series(1, $2) g`,
    [id, benches],
  );
  return id;
}

async function mkExam(subject: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/exams')
    .set(auth(superToken))
    .send({
      subject,
      examDate: nextDate(),
      startTime: '09:00',
      endTime: '12:00',
      academicYearId: yearId,
      autoRegister: false,
    });
  expect(res.status).toBe(201);
  return res.body.exam.id as string;
}

async function generate(examId: string, roomIds: string[]): Promise<void> {
  const res = await request(app)
    .post(`/api/v1/seating/exams/${examId}/generate-seating`)
    .set(auth(superToken))
    .send({ mode: 'MIXED', seed: `export-${suffix}`, roomIds });
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
  superAdmin = await createTestUser(pool, { role: 'SUPER_ADMIN', password: PW, email: `sa-exp-${suffix}@test.local` });
  examAdmin = await createTestUser(pool, { role: 'EXAM_ADMIN', password: PW, email: `ea-exp-${suffix}@test.local` });
  superToken = await login(superAdmin.email);
  examAdminToken = await login(examAdmin.email);

  yearId = (await prisma.academicYear.create({ data: { name: `Export Year ${suffix}`, code: `EY${suffix}` } })).id;
  deptACode = `EXDA${suffix}`;
  deptBCode = `EXDB${suffix}`;
  deptA = (await prisma.department.create({ data: { name: `Export Dept A ${suffix}`, code: deptACode } })).id;
  deptB = (await prisma.department.create({ data: { name: `Export Dept B ${suffix}`, code: deptBCode } })).id;

  roomNumberA = `EXPA-${suffix}`;
  roomNumberB = `EXPB-${suffix}`;
  roomA = await mkRoom(roomNumberA, 4);
  roomB = await mkRoom(roomNumberB, 4);

  // 5 students in dept A, 2 in dept B -> 7 seated across 2 rooms (8 benches).
  const deptARolls: string[] = [];
  const deptBRolls: string[] = [];
  for (let i = 0; i < 5; i++) {
    const s = await mkStudent(i, deptA, deptACode);
    studentIds.push(s.id);
    deptARolls.push(s.roll);
  }
  for (let i = 5; i < 7; i++) {
    const s = await mkStudent(i, deptB, deptBCode);
    studentIds.push(s.id);
    deptBRolls.push(s.roll);
  }
  allRolls = [...deptARolls, ...deptBRolls];

  const studentUser = await createTestUser(pool, {
    role: 'STUDENT',
    password: PW,
    studentId: studentIds[0]!,
    email: `st-exp-${suffix}@test.local`,
  });
  studentToken = await login(studentUser.email);

  pubExamId = await mkExam(`Export Exam ${suffix}`);
  pubSubject = `Export Exam ${suffix}`;
  await prisma.examRegistration.createMany({ data: studentIds.map((studentId) => ({ examId: pubExamId, studentId })) });
  await generate(pubExamId, [roomA, roomB]);
  await publish(pubExamId);
  seatedStudentId = studentIds[0]!;

  draftExamId = await mkExam(`Draft Export Exam ${suffix}`);
  await prisma.examRegistration.createMany({
    data: studentIds.slice(0, 3).map((studentId) => ({ examId: draftExamId, studentId })),
  });
  await generate(draftExamId, [roomA]);
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  await pool.end();
});

describe('Phase 10: exports — access control', () => {
  it('rejects anonymous callers with 401 and students with 403', async () => {
    for (const path of ['classroom', 'plan', 'slips']) {
      const anon = await request(app).get(`/api/v1/exports/exams/${pubExamId}/${path}`);
      expect(anon.status, path).toBe(401);

      const student = await request(app).get(`/api/v1/exports/exams/${pubExamId}/${path}`).set(auth(studentToken));
      expect(student.status, path).toBe(403);
      expect(student.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('allows EXAM_ADMIN (not only SUPER_ADMIN) to export', async () => {
    const res = await request(app)
      .get(`/api/v1/exports/exams/${pubExamId}/classroom?format=csv`)
      .set(auth(examAdminToken));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });
});

describe('Phase 10: published plan exports', () => {
  it('classroom-wise CSV: correct content-type, filename, one row per student, no watermark', async () => {
    const res = await request(app)
      .get(`/api/v1/exports/exams/${pubExamId}/classroom?format=csv`)
      .set(auth(superToken));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment; filename="seating-classroom-');
    expect(res.headers['content-disposition']).toContain('.csv"');

    const body = res.text;
    expect(body).not.toContain(DRAFT);
    expect(body).toContain(roomNumberA);
    expect(body).toContain(roomNumberB);
    expect(body).toContain(pubSubject);
    expect(body).toContain('Bench,Roll No,Name,Department');
    for (const roll of allRolls) expect(body, roll).toContain(roll);

    const studentRows = body
      .split('\n')
      .filter((line) => allRolls.some((roll) => line.includes(roll)));
    expect(studentRows).toHaveLength(7);
  });

  it('classroom-wise XLSX: one sheet per room, all 7 students, no watermark', async () => {
    const got = await binaryGet(`/api/v1/exports/exams/${pubExamId}/classroom?format=xlsx`, superToken);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toContain('spreadsheetml');
    expect(got.headers['content-disposition']).toContain('.xlsx"');

    const wb = await loadWorkbook(got.body);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toHaveLength(2);
    expect(names).toContain(roomNumberA);
    expect(names).toContain(roomNumberB);

    let seated = 0;
    for (const sheet of wb.worksheets) {
      expect(sheet.getCell('A1').text ?? String(sheet.getCell('A1').value)).not.toContain('DRAFT');
      const header = sheet.getRow(5).values as unknown[];
      expect(String(header[2])).toBe('Roll No');
      for (let r = 6; r <= sheet.rowCount; r++) {
        const roll = sheet.getRow(r).getCell(2).text;
        if (roll) seated++;
      }
    }
    expect(seated).toBe(7);
  });

  it('department-wise CSV/XLSX: separate sections/sheets per department', async () => {
    const csv = await request(app)
      .get(`/api/v1/exports/exams/${pubExamId}/department?format=csv`)
      .set(auth(superToken));
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(`Department,${deptACode}`);
    expect(csv.text).toContain(`Department,${deptBCode}`);
    const deptRows = csv.text.split('\n').filter((l) => allRolls.some((roll) => l.includes(roll)));
    expect(deptRows).toHaveLength(7);

    const got = await binaryGet(`/api/v1/exports/exams/${pubExamId}/department?format=xlsx`, superToken);
    expect(got.status).toBe(200);
    const wb = await loadWorkbook(got.body);
    const names = wb.worksheets.map((w) => w.name).sort();
    expect(names).toEqual([deptACode, deptBCode].sort());
    expect(wb.worksheets.reduce((sum, w) => sum + (w.rowCount - 5), 0)).toBe(7);
  });

  it('student-wise CSV is sorted by roll number with the exact required columns', async () => {
    const res = await request(app).get(`/api/v1/exports/exams/${pubExamId}/students?format=csv`).set(auth(superToken));
    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toContain('Exam,');
    expect(lines[1]).toBe('Roll No,Name,Department,Room,Bench');
    expect(lines).toHaveLength(9); // exam meta + header + 7 students
    const rolls = lines.slice(2).map((l) => l.split(',')[0]!);
    expect(rolls).toEqual([...rolls].sort());
    expect(new Set(rolls).size).toBe(7);
  });

  it('student-wise PDF renders every roll on a printable list', async () => {
    const got = await binaryGet(`/api/v1/exports/exams/${pubExamId}/students?format=pdf`, superToken);
    expect(got.status).toBe(200);
    expect(got.body.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(got.headers['content-type']).toContain('application/pdf');
    const { text, pages } = decodePdf(got.body);
    expect(text).toContain('Student-wise Seating List');
    for (const roll of allRolls) expect(text, roll).toContain(roll);
    expect(pages).toBeGreaterThanOrEqual(1);
  });

  it('complete plan PDF: cover summary page + one page per room, invigilator signature', async () => {
    const got = await binaryGet(`/api/v1/exports/exams/${pubExamId}/plan?format=pdf`, superToken);
    expect(got.status).toBe(200);
    expect(got.headers['content-disposition']).toContain('seating-plan-');
    const { text, pages } = decodePdf(got.body);
    expect(text).toContain('Complete Seating Plan');
    expect(text).toContain(pubSubject);
    expect(text).toContain('Students seated: 7');
    expect(text).toContain('Rooms used: 2');
    expect(text).toContain('Invigilator Signature');
    expect(pages).toBe(3); // cover + 2 rooms
    expect(text).not.toContain(DRAFT);
  });

  it('complete plan XLSX: Cover sheet with totals + one sheet per room', async () => {
    const got = await binaryGet(`/api/v1/exports/exams/${pubExamId}/plan?format=xlsx`, superToken);
    expect(got.status).toBe(200);
    const wb = await loadWorkbook(got.body);
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toHaveLength(3);
    expect(names[0]).toBe('Cover');
    expect(names).toContain(roomNumberA);
    expect(names).toContain(roomNumberB);

    const cover = wb.getWorksheet('Cover')!;
    let studentsCell: unknown;
    let roomsCell: unknown;
    cover.eachRow((row) => {
      const values = row.values as unknown[];
      if (values[1] === 'Students seated') studentsCell = values[2];
      if (values[1] === 'Rooms used') roomsCell = values[2];
    });
    expect(Number(studentsCell)).toBe(7);
    expect(Number(roomsCell)).toBe(2);
    expect(String(cover.getCell('A1').value)).not.toContain('DRAFT');
  });

  it('single student slip PDF contains the exact seat and professional layout fields', async () => {
    const got = await binaryGet(
      `/api/v1/exports/exams/${pubExamId}/slip?studentId=${seatedStudentId}`,
      superToken,
    );
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toContain('application/pdf');
    expect(got.headers['content-disposition']).toContain('attachment; filename="slip-');
    const { text } = decodePdf(got.body);
    expect(text).toContain('EXAM SEATING SLIP');
    expect(text).toContain(pubSubject);
    expect(text).toContain(allRolls[0]);
    expect(text).toMatch(/Room: EXP[AB]-[a-z0-9]+ {3}\/ {3}Bench: [1-4]/);
  });

  it('bulk slips: 7 slips over 2 A4 pages (6 per page), every roll present', async () => {
    const got = await binaryGet(`/api/v1/exports/exams/${pubExamId}/slips`, superToken);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toContain('application/pdf');
    const { text, pages } = decodePdf(got.body);
    expect(pages).toBe(2);
    for (const roll of allRolls) expect(text, roll).toContain(roll);
    const slipCount = (text.match(/EXAM SEATING SLIP/g) || []).length;
    expect(slipCount).toBe(7);
  });

  it('writes an audit row for every export action', async () => {
    const actions = await prisma.auditLog.findMany({
      where: { action: { startsWith: 'export.' } },
      select: { action: true, entityType: true, actorUserId: true, entityId: true },
    });
    const seen = new Set(actions.map((a) => a.action));
    for (const expected of [
      'export.classroom_wise',
      'export.department_wise',
      'export.student_wise',
      'export.full_plan',
      'export.slip',
      'export.bulk_slips',
    ]) {
      expect(seen, expected).toContain(expected);
    }
    const row = actions.find((a) => a.action === 'export.full_plan')!;
    expect(row.entityType).toBe('exam');
    expect(row.entityId).toBe(pubExamId);
    expect(row.actorUserId).toBe(superAdmin.id);
  });
});

describe('Phase 10: drafts require includeDraft and are watermarked', () => {
  it('refuses to export a VALIDATED-only plan without includeDraft (409 CONFLICT)', async () => {
    const res = await request(app)
      .get(`/api/v1/exports/exams/${draftExamId}/classroom?format=csv`)
      .set(auth(superToken));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toContain('PUBLISHED');
    expect(res.body.error.message).toContain('includeDraft=true');
  });

  it('exports the draft with a visible watermark in CSV, XLSX and PDF', async () => {
    const csv = await request(app)
      .get(`/api/v1/exports/exams/${draftExamId}/classroom?format=csv&includeDraft=true`)
      .set(auth(superToken));
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(DRAFT);

    const xlsx = await binaryGet(
      `/api/v1/exports/exams/${draftExamId}/classroom?format=xlsx&includeDraft=true`,
      superToken,
    );
    expect(xlsx.status).toBe(200);
    const wb = await loadWorkbook(xlsx.body);
    expect(String(wb.worksheets[0]!.getCell('A1').value)).toBe(DRAFT);

    const plan = await binaryGet(
      `/api/v1/exports/exams/${draftExamId}/plan?format=pdf&includeDraft=true`,
      superToken,
    );
    expect(plan.status).toBe(200);
    const { text, pages } = decodePdf(plan.body);
    expect(text).toContain(DRAFT);
    expect(pages).toBe(2); // cover + 1 room
  });

  it('serves a draft slip with watermark when includeDraft=true', async () => {
    const got = await binaryGet(
      `/api/v1/exports/exams/${draftExamId}/slip?studentId=${seatedStudentId}&includeDraft=true`,
      superToken,
    );
    expect(got.status).toBe(200);
    const { text } = decodePdf(got.body);
    expect(text).toContain('EXAM SEATING SLIP');
    expect(text).toContain(DRAFT);
  });

  it('bulk slips on a draft also refuse by default (409)', async () => {
    const res = await request(app).get(`/api/v1/exports/exams/${draftExamId}/slips`).set(auth(superToken));
    expect(res.status).toBe(409);
  });
});

describe('Phase 10: input validation', () => {
  it('rejects unknown formats, bad UUIDs and unknown exams', async () => {
    const badFormat = await request(app)
      .get(`/api/v1/exports/exams/${pubExamId}/classroom?format=docx`)
      .set(auth(superToken));
    expect(badFormat.status).toBe(400);
    expect(badFormat.body.error.code).toBe('VALIDATION_ERROR');

    const csvPlan = await request(app)
      .get(`/api/v1/exports/exams/${pubExamId}/plan?format=csv`)
      .set(auth(superToken));
    expect(csvPlan.status).toBe(400);

    const badExam = await request(app)
      .get('/api/v1/exports/exams/not-a-uuid/classroom')
      .set(auth(superToken));
    expect(badExam.status).toBe(400);

    const unknownExam = await request(app)
      .get(`/api/v1/exports/exams/${randomUUID()}/classroom`)
      .set(auth(superToken));
    expect(unknownExam.status).toBe(404);

    const badStudent = await request(app)
      .get(`/api/v1/exports/exams/${pubExamId}/slip?studentId=nope`)
      .set(auth(superToken));
    expect(badStudent.status).toBe(400);

    const missingStudent = await request(app)
      .get(`/api/v1/exports/exams/${pubExamId}/slip`)
      .set(auth(superToken));
    expect(missingStudent.status).toBe(400);

    const unknownStudent = await request(app)
      .get(`/api/v1/exports/exams/${pubExamId}/slip?studentId=${randomUUID()}`)
      .set(auth(superToken));
    expect(unknownStudent.status).toBe(404);
  });
});

describe('Phase 10: performance — 5,000-student exports', () => {
  it(
    'generates and serves CSV + XLSX exports for 5,000 seated students within time and size limits',
    async () => {
      // Build a PUBLISHED run of 5,000 students directly (this test exercises
      // the export path, not the allocator). The fixture runs in one
      // transaction with session_replication_role=replica where permitted:
      // row-level FK + capacity triggers make 10k-row inserts ~5x slower here
      // and carry no value for fixture data we fully control. When the test DB
      // role is not superuser the SET is skipped and triggers simply run.
      const bigExam = await mkExam(`Perf Export Exam ${suffix}`);
      const bigExamSubjectRow = await prisma.exam.findUniqueOrThrow({ where: { id: bigExam } });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp');
        try {
          await client.query('SET LOCAL session_replication_role = replica');
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT sp');
        }

        for (const [roomNumber, benches] of [
          [`BIGA-${suffix}`, 2500],
          [`BIGB-${suffix}`, 2500],
        ] as const) {
          await client.query(
            `INSERT INTO classrooms (id, room_number, building, floor, status, capacity)
             VALUES ($1, $2, 'Main', '1', 'AVAILABLE', $3)`,
            [randomUUID(), roomNumber, benches],
          );
          await client.query(
            `INSERT INTO seats (id, classroom_id, bench_number, status, row_no, col_no)
             SELECT gen_random_uuid(), c.id, g, 'AVAILABLE', g, 1
             FROM classrooms c, generate_series(1, $2) g
             WHERE c.room_number = $1`,
            [roomNumber, benches],
          );
        }

        await client.query(
          `INSERT INTO students (id, roll_number, name, status, academic_year_id, department_id)
           SELECT gen_random_uuid(), 'EXP5K-' || lpad(g::text, 5, '0'), 'Perf Student ' || g, 'ACTIVE', $1, $2
           FROM generate_series(0, 4999) g`,
          [yearId, deptA],
        );

        const runId = randomUUID();
        await client.query(
          `INSERT INTO seating_runs (id, exam_id, seed, status, algorithm_version, config, total_penalty)
           VALUES ($1, $2, 'perf-export', 'VALIDATED', 'v1-perf', '{}'::jsonb, 0)`,
          [runId, bigExam],
        );

        // Pair the i-th student (by roll) with the i-th seat (by room/bench),
        // then promote the VALIDATED run to PUBLISHED in one transaction.
        await client.query(
          `INSERT INTO seating_allocations
             (id, run_id, exam_id, student_id, classroom_id, seat_id, academic_year_id, department_id)
           SELECT gen_random_uuid(), $1, $2, st.id, se.classroom_id, se.id, $3, $4
           FROM (
             SELECT id, row_number() OVER (ORDER BY roll_number) rn
             FROM students WHERE roll_number LIKE 'EXP5K-%'
           ) st
           JOIN (
             SELECT s.id, s.classroom_id, row_number() OVER (ORDER BY s.classroom_id, s.bench_number) rn
             FROM seats s JOIN classrooms c ON c.id = s.classroom_id
             WHERE c.room_number LIKE 'BIG%'
           ) se ON se.rn = st.rn`,
          [runId, bigExam, yearId, deptA],
        );
        await client.query(`UPDATE seating_runs SET status = 'PUBLISHED', published_at = now() WHERE id = $1`, [runId]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      expect(bigExamSubjectRow.subject).toContain('Perf Export Exam');
      expect((await prisma.seatingAllocation.count({ where: { examId: bigExam } }))).toBe(5000);

      const csvStart = Date.now();
      const csv = await binaryGet(`/api/v1/exports/exams/${bigExam}/students?format=csv`, superToken);
      const csvMs = Date.now() - csvStart;
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.body.byteLength).toBeGreaterThan(50_000);
      expect(csv.body.byteLength).toBeLessThan(20 * 1024 * 1024);
      const lines = csv.body.toString('utf8').trim().split('\n');
      expect(lines).toHaveLength(5002); // exam meta + header + 5000 students
      expect(csvMs).toBeLessThan(15_000);

      const xlsxStart = Date.now();
      const xlsx = await binaryGet(`/api/v1/exports/exams/${bigExam}/classroom?format=xlsx`, superToken);
      const xlsxMs = Date.now() - xlsxStart;
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      expect(xlsx.body.byteLength).toBeGreaterThan(50_000);
      const wb = await loadWorkbook(xlsx.body);
      expect(wb.worksheets).toHaveLength(2);
      const seated = wb.worksheets.reduce(
        (sum, w) => sum + Math.max(0, w.rowCount - 5), // rows minus watermark-free header block + table head
        0,
      );
      expect(seated).toBe(5000);
      expect(xlsxMs).toBeLessThan(30_000);
    },
    90_000,
  );
});
