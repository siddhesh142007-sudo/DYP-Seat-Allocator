import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestPool, truncateAll } from './helpers/db.js';
import { createTestUser } from './helpers/auth.js';
import { createApp } from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/db/prisma.js';

const PW = 'RoomImport123!';
const HEADERS = 'room_number,building,floor,bench_count';

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let superToken: string;
const suffix = randomUUID().slice(0, 8);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

function csv(rows: string[]): Buffer {
  return Buffer.from(`${[HEADERS, ...rows].join('\n')}\n`);
}

function row(room: string, building = 'Main', floor = '1', benches: string | number = 4): string {
  return `${room},${building},${floor},${benches}`;
}

async function upload(buffer: Buffer, filename: string, dryRun: boolean, token = superToken) {
  return request(app)
    .post('/api/v1/classrooms/import')
    .set(auth(token))
    .field('dryRun', String(dryRun))
    .attach('file', buffer, filename);
}

beforeAll(async () => {
  pool = createTestPool(5);
  await truncateAll(pool);
  app = createApp();
  const admin = await createTestUser(pool, { role: 'SUPER_ADMIN', password: PW, email: `sa-roomimp-${suffix}@test.local` });
  superToken = (
    await request(app).post('/api/v1/auth/login').send({ identifier: admin.email, password: PW })
  ).body.accessToken as string;
});

afterAll(async () => {
  await disconnectPrisma();
  await pool.end();
});

describe('Phase 10: classroom import — access + template', () => {
  it('rejects anonymous requests with 401', async () => {
    expect((await request(app).post('/api/v1/classrooms/import')).status).toBe(401);
  });

  it('serves a CSV template with the documented headers', async () => {
    const res = await request(app).get('/api/v1/classrooms/import/template').set(auth(superToken));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.split('\n')[0]).toBe(HEADERS);
  });

  it('serves an XLSX template', async () => {
    const res = await request(app)
      .get('/api/v1/classrooms/import/template?format=xlsx')
      .set(auth(superToken))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect((res.body as Buffer).byteLength).toBeGreaterThan(1000);
  });

  it('does not mistake /import/template for a classroom id', async () => {
    const res = await request(app).get('/api/v1/classrooms/import/template').set(auth(superToken));
    expect(res.status).toBe(200);
  });
});

describe('Phase 10: classroom import — validation', () => {
  it('400s when the file is missing or the type is unsupported', async () => {
    const missing = await request(app).post('/api/v1/classrooms/import').set(auth(superToken)).field('dryRun', 'true');
    expect(missing.status).toBe(400);

    const wrongType = await upload(Buffer.from('a,b\n1,2'), 'rooms.txt', true);
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.message).toContain('.csv or .xlsx');
  });

  it('dry-run flags missing fields, bad bench counts and duplicate rooms without writing', async () => {
    const room = `VAL-${suffix}`;
    const res = await upload(
      csv([
        `${room},Main,1,4`,
        `,Main,1,4`,
        `BADBENCH-${suffix},Main,1,abc`,
        `ZEROBENCH-${suffix},Main,1,0`,
        `${room},Main,1,4`,
      ]),
      'rooms.csv',
      true,
    );
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.summary.errors).toBe(4);
    expect(res.body.rows[1].errors[0]).toContain('room_number is required');
    expect(res.body.rows[2].errors[0]).toContain('bench_count');
    expect(res.body.rows[3].errors[0]).toContain('at least 1');
    expect(res.body.rows[4].errors[0]).toContain('duplicate room_number');
    expect(await prisma.classroom.findUnique({ where: { roomNumber: room } })).toBeNull();
  });

  it('commit with any error → 422 and imports nothing', async () => {
    const good = `GOOD-${suffix}`;
    const res = await upload(csv([row(good), `BAD-${suffix},,,-5`]), 'rooms.csv', false);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNPROCESSABLE_ENTITY');
    expect(res.body.error.details.summary).toMatchObject({ errors: 1, created: 0 });
    expect(await prisma.classroom.findUnique({ where: { roomNumber: good } })).toBeNull();
  });
});

describe('Phase 10: classroom import — commit', () => {
  it('creates classrooms with their benches, skips existing rooms, and audits', async () => {
    const roomA = `NEWA-${suffix}`;
    const roomB = `NEWB-${suffix}`;

    const first = await upload(csv([row(roomA, 'Block A', '2', 5), row(roomB, 'Block B', '3', 3)]), 'rooms.csv', false);
    expect(first.status).toBe(200);
    expect(first.body.summary).toMatchObject({ total: 2, created: 2, skipped: 0, errors: 0 });

    const createdA = await prisma.classroom.findUnique({ where: { roomNumber: roomA }, include: { seats: true } });
    expect(createdA).not.toBeNull();
    expect(createdA!.building).toBe('Block A');
    expect(createdA!.floor).toBe('2');
    expect(createdA!.capacity).toBe(5);
    expect(createdA!.seats).toHaveLength(5);
    expect(createdA!.seats.map((s) => s.benchNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);

    const createdB = await prisma.classroom.findUnique({ where: { roomNumber: roomB }, include: { seats: true } });
    expect(createdB!.seats).toHaveLength(3);

    // Re-importing the same rooms skips them (no updates, no duplicates).
    const second = await upload(csv([row(roomA, 'Renamed', '9', 9), row(roomB)]), 'rooms.csv', false);
    expect(second.status).toBe(200);
    expect(second.body.summary).toMatchObject({ total: 2, created: 0, skipped: 2, errors: 0 });
    const unchanged = await prisma.classroom.findUnique({ where: { roomNumber: roomA }, include: { seats: true } });
    expect(unchanged!.building).toBe('Block A');
    expect(unchanged!.seats).toHaveLength(5);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'classroom.import' } });
    expect(audit).not.toBeNull();
    expect(audit!.entityType).toBe('classroom');
  });

  it('imports a room from an XLSX file', async () => {
    const room = `XLSX-${suffix}`;
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Rooms');
    sheet.addRow(['room_number', 'building', 'floor', 'bench_count']);
    sheet.addRow([room, 'XBlock', '4', 6]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await upload(Buffer.from(buffer), 'rooms.xlsx', false);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ created: 1, errors: 0 });
    const created = await prisma.classroom.findUnique({ where: { roomNumber: room }, include: { seats: true } });
    expect(created!.seats).toHaveLength(6);
  });

  it('imports 500 rooms in one request', async () => {
    const rows: string[] = [];
    for (let i = 0; i < 500; i++) rows.push(row(`BULK${String(i).padStart(4, '0')}-${suffix}`, 'Main', '1', 1));
    const res = await upload(csv(rows), 'big.csv', false);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ total: 500, created: 500, errors: 0 });
    expect(await prisma.classroom.count({ where: { roomNumber: { startsWith: 'BULK' } } })).toBe(500);
  }, 60_000);
});