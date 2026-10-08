import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestPool, truncateAll } from './helpers/db.js';
import { createTestUser } from './helpers/auth.js';
import { createApp } from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/db/prisma.js';

const PW = 'AdminSecret123!';

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let superToken: string;
let yearName: string;
let deptCode: string;

beforeAll(async () => {
  pool = createTestPool(5);
  await truncateAll(pool);
  app = createApp();
  const superAdmin = await createTestUser(pool, { role: 'SUPER_ADMIN', password: PW, email: 'sa-imp@test.local' });
  superToken = (await request(app).post('/api/v1/auth/login').send({ identifier: superAdmin.email, password: PW })).body
    .accessToken;

  const suffix = randomUUID().slice(0, 8);
  yearName = `Import Year ${suffix}`;
  deptCode = `IMP${suffix.slice(0, 6)}`;
  await prisma.academicYear.create({ data: { name: yearName, code: `IY${suffix.slice(0, 6)}` } });
  await prisma.department.create({ data: { name: `Import Dept ${suffix}`, code: deptCode } });
}, 60000);

afterAll(async () => {
  await pool.end();
  await disconnectPrisma();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const HEADER = 'roll_number,name,email,division,department_code,academic_year,status';

function csv(rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join('\n') + '\n');
}

function row(roll: string, name = 'Imported Student', overrides: Partial<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    roll_number: roll,
    name,
    email: '',
    division: 'A',
    department_code: deptCode,
    academic_year: yearName,
    status: 'ACTIVE',
    ...overrides,
  };
  return [
    fields.roll_number,
    fields.name,
    fields.email,
    fields.division,
    fields.department_code,
    fields.academic_year,
    fields.status,
  ].join(',');
}

function upload(buffer: Buffer, filename: string, dryRun: boolean, token = superToken) {
  const req = request(app).post('/api/v1/students/import').set(auth(token));
  if (dryRun) req.field('dryRun', 'true');
  return req.attach('file', buffer, filename);
}

describe('GET /students/import/template', () => {
  it('serves a CSV template with the expected headers', async () => {
    const res = await request(app).get('/api/v1/students/import/template').set(auth(superToken));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('students-template.csv');
    expect(res.text.split('\n')[0]).toBe(HEADER);
  });

  it('serves an XLSX template', async () => {
    const res = await request(app)
      .get('/api/v1/students/import/template')
      .query({ format: 'xlsx' })
      .set(auth(superToken))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).length).toBeGreaterThan(100); // xlsx zip payload
  });

  it('rejects anonymous requests with 401', async () => {
    const res = await request(app).get('/api/v1/students/import/template');
    expect(res.status).toBe(401);
  });
});

describe('POST /students/import', () => {
  it('400s when the file field is missing', async () => {
    const res = await request(app).post('/api/v1/students/import').set(auth(superToken)).field('dryRun', 'true');
    expect(res.status).toBe(400);
  });

  it('400s for an unsupported file type', async () => {
    const res = await upload(Buffer.from('a,b\n1,2'), 'data.txt', true);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('.csv or .xlsx');
  });

  it('dry-run reports creates without writing anything', async () => {
    const roll = `DR${randomUUID().slice(0, 8)}`;
    const res = await upload(csv([row(roll)]), 'students.csv', true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, valid: true });
    expect(res.body.summary).toMatchObject({ total: 1, created: 0, updated: 0, skipped: 0, errors: 0 });
    expect(res.body.rows[0]).toMatchObject({ row: 2, rollNumber: roll, action: 'create', errors: [] });
    expect(await prisma.student.findUnique({ where: { rollNumber: roll } })).toBeNull();
  });

  it('dry-run flags unknown departments, unknown years and duplicate rolls', async () => {
    const roll = `ER${randomUUID().slice(0, 8)}`;
    const res = await upload(
      csv([
        row(roll, 'Bad Dept', { department_code: 'NOPE' }),
        row(`${roll}B`, 'Bad Year', { academic_year: '1999-00' }),
        row(roll, 'Duplicate'),
      ]),
      'students.csv',
      true,
    );
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.summary.errors).toBe(3);
    expect(res.body.rows[0].errors[0]).toContain('unknown department');
    expect(res.body.rows[1].errors[0]).toContain('unknown academic year');
    expect(res.body.rows[2].errors[0]).toContain('duplicate roll_number');
  });

  it('commit with any row error → 422 and imports nothing', async () => {
    const good = `GD${randomUUID().slice(0, 8)}`;
    const res = await upload(csv([row(good), row('BADROLL', 'Bad', { department_code: 'NOPE' })]), 'students.csv', false);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNPROCESSABLE_ENTITY');
    expect(res.body.error.details.summary).toMatchObject({ errors: 1, created: 0 });
    expect(await prisma.student.findUnique({ where: { rollNumber: good } })).toBeNull();
  });

  it('commits clean files, then updates changed rows and skips unchanged ones', async () => {
    const rollA = `CA${randomUUID().slice(0, 8)}`;
    const rollB = `CB${randomUUID().slice(0, 8)}`;

    const first = await upload(csv([row(rollA, 'First Name'), row(rollB, 'Second Name')]), 'students.csv', false);
    expect(first.status).toBe(200);
    expect(first.body.summary).toMatchObject({ total: 2, created: 2, updated: 0, skipped: 0, errors: 0 });

    const second = await upload(
      csv([row(rollA, 'Renamed Student'), row(rollB, 'Second Name')]),
      'students.csv',
      false,
    );
    expect(second.status).toBe(200);
    expect(second.body.summary).toMatchObject({ created: 0, updated: 1, skipped: 1, errors: 0 });

    const renamed = await prisma.student.findUnique({ where: { rollNumber: rollA } });
    expect(renamed!.name).toBe('Renamed Student');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'student.import' } });
    expect(audit).not.toBeNull();
  });

  it('imports 500 rows in one request', async () => {
    const rows: string[] = [];
    for (let i = 0; i < 500; i++) {
      rows.push(row(`BIG${String(i).padStart(5, '0')}`, `Bulk Student ${i}`));
    }
    const res = await upload(csv(rows), 'big.csv', false);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ total: 500, created: 500, errors: 0 });

    const count = await prisma.student.count({ where: { rollNumber: { startsWith: 'BIG' } } });
    expect(count).toBe(500);
  }, 60000);

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).post('/api/v1/students/import');
    expect(res.status).toBe(401);
  });
});
