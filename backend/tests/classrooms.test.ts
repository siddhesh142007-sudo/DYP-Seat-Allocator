import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createTestPool, truncateAll } from './helpers/db.js';
import { createTestUser, createTestStudent } from './helpers/auth.js';
import { insertAllocation, createFixture, type Fixture } from './helpers/fixtures.js';
import { createApp } from '../src/app.js';
import { prisma, disconnectPrisma } from '../src/db/prisma.js';

const PW = 'AdminSecret123!';

let pool: pg.Pool;
let app: ReturnType<typeof createApp>;
let superToken: string;
let studentToken: string;
let fixture: Fixture;

beforeAll(async () => {
  pool = createTestPool(5);
  await truncateAll(pool);
  app = createApp();
  const superAdmin = await createTestUser(pool, { role: 'SUPER_ADMIN', password: PW, email: 'sa-room@test.local' });
  const studentRow = await createTestStudent(pool, { rollPrefix: 'CR' });
  const studentUser = await createTestUser(pool, { role: 'STUDENT', password: PW, studentId: studentRow.id });
  superToken = (await request(app).post('/api/v1/auth/login').send({ identifier: superAdmin.email, password: PW })).body
    .accessToken;
  studentToken = (await request(app).post('/api/v1/auth/login').send({ identifier: studentUser.email, password: PW }))
    .body.accessToken;
  fixture = await createFixture(pool);
}, 60000);

afterAll(async () => {
  await pool.end();
  await disconnectPrisma();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function createRoom(): Promise<string> {
  const res = await request(app)
    .post('/api/v1/classrooms')
    .set(auth(superToken))
    .send({ roomNumber: `C-${randomUUID().slice(0, 8)}`, building: 'Science', floor: '2' });
  expect(res.status).toBe(201);
  return res.body.classroom.id as string;
}

describe('classroom CRUD', () => {
  it('rejects STUDENT role with 403 and anonymous with 401', async () => {
    expect((await request(app).get('/api/v1/classrooms').set(auth(studentToken))).status).toBe(403);
    expect((await request(app).get('/api/v1/classrooms')).status).toBe(401);
  });

  it('creates, duplicates (409) and updates a room', async () => {
    const roomNumber = `D-${randomUUID().slice(0, 8)}`;
    const created = await request(app)
      .post('/api/v1/classrooms')
      .set(auth(superToken))
      .send({ roomNumber, building: 'A', floor: '1' });
    expect(created.status).toBe(201);

    const dup = await request(app).post('/api/v1/classrooms').set(auth(superToken)).send({ roomNumber });
    expect(dup.status).toBe(409);

    const updated = await request(app)
      .put(`/api/v1/classrooms/${created.body.classroom.id}`)
      .set(auth(superToken))
      .send({ status: 'UNAVAILABLE', notes: 'Under maintenance' });
    expect(updated.status).toBe(200);
    expect(updated.body.classroom).toMatchObject({ status: 'UNAVAILABLE', notes: 'Under maintenance' });
  });

  it('lists rooms with seat counts', async () => {
    const res = await request(app).get('/api/v1/classrooms').set(auth(superToken));
    expect(res.status).toBe(200);
    const fixtureRoom = res.body.items.find((c: { id: string }) => c.id === fixture.classroomId);
    expect(fixtureRoom).toMatchObject({ totalSeats: 2, availableSeats: 2, capacity: 2 });
  });

  it('404s for unknown rooms', async () => {
    const res = await request(app)
      .get('/api/v1/classrooms/00000000-0000-4000-8000-000000000000')
      .set(auth(superToken));
    expect(res.status).toBe(404);
  });
});

describe('seats', () => {
  it('generates benches and the capacity trigger follows', async () => {
    const id = await createRoom();
    const res = await request(app)
      .post(`/api/v1/classrooms/${id}/generate-seats`)
      .set(auth(superToken))
      .send({ count: 12 });
    expect(res.status).toBe(201);
    expect(res.body.classroom.seats).toHaveLength(12);
    expect(res.body.classroom.totalSeats).toBe(12);
    expect(res.body.classroom.capacity).toBe(12); // DB trigger, not application code
  });

  it('generates a rows×cols layout with row/col numbers', async () => {
    const id = await createRoom();
    const res = await request(app)
      .post(`/api/v1/classrooms/${id}/generate-seats`)
      .set(auth(superToken))
      .send({ count: 6, rows: 2, cols: 3 });
    expect(res.status).toBe(201);
    const seats = res.body.classroom.seats as { benchNumber: number; rowNo: number; colNo: number }[];
    expect(seats[5]).toMatchObject({ benchNumber: 6, rowNo: 2, colNo: 3 });
  });

  it('rejects count ≠ rows×cols and mismatched layout with 400', async () => {
    const id = await createRoom();
    const bad = await request(app)
      .post(`/api/v1/classrooms/${id}/generate-seats`)
      .set(auth(superToken))
      .send({ count: 5, rows: 2, cols: 3 });
    expect(bad.status).toBe(400);

    const partial = await request(app)
      .post(`/api/v1/classrooms/${id}/generate-seats`)
      .set(auth(superToken))
      .send({ count: 4, rows: 2 });
    expect(partial.status).toBe(400);
  });

  it('refuses to generate over existing benches (409), clears, then regenerates', async () => {
    const id = await createRoom();
    await request(app).post(`/api/v1/classrooms/${id}/generate-seats`).set(auth(superToken)).send({ count: 4 });

    const again = await request(app)
      .post(`/api/v1/classrooms/${id}/generate-seats`)
      .set(auth(superToken))
      .send({ count: 6 });
    expect(again.status).toBe(409);

    const cleared = await request(app).delete(`/api/v1/classrooms/${id}/seats`).set(auth(superToken));
    expect(cleared.status).toBe(200);
    expect(cleared.body.classroom.totalSeats).toBe(0);
    expect(cleared.body.classroom.capacity).toBe(0);

    const regen = await request(app)
      .post(`/api/v1/classrooms/${id}/generate-seats`)
      .set(auth(superToken))
      .send({ count: 6 });
    expect(regen.status).toBe(201);
  });

  it('disabling a bench drops the room capacity (trigger)', async () => {
    const id = await createRoom();
    const gen = await request(app)
      .post(`/api/v1/classrooms/${id}/generate-seats`)
      .set(auth(superToken))
      .send({ count: 3 });
    const seat = (gen.body.classroom.seats as { id: string }[])[1]!;

    const patched = await request(app)
      .patch(`/api/v1/classrooms/${id}/seats/${seat.id}`)
      .set(auth(superToken))
      .send({ status: 'DISABLED' });
    expect(patched.status).toBe(200);
    expect(patched.body.seat.status).toBe('DISABLED');

    const room = await request(app).get(`/api/v1/classrooms/${id}`).set(auth(superToken));
    expect(room.body.classroom.capacity).toBe(2);
    expect(room.body.classroom.availableSeats).toBe(2);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'classroom.seat.update', entityId: seat.id } });
    expect(audit).not.toBeNull();
  });

  it('404s for a seat in another room', async () => {
    const res = await request(app)
      .patch(`/api/v1/classrooms/${fixture.classroomId}/seats/${fixture.otherSeats[0]}`)
      .set(auth(superToken))
      .send({ status: 'DISABLED' });
    expect(res.status).toBe(404);
  });
});

describe('deletion rules', () => {
  it('refuses to delete a room with seating history (409) and suggests unavailable', async () => {
    await insertAllocation(pool, fixture);
    const res = await request(app)
      .delete(`/api/v1/classrooms/${fixture.classroomId}`)
      .set(auth(superToken));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('unavailable');
  });

  it('refuses to clear benches referenced by allocations (409)', async () => {
    const res = await request(app)
      .delete(`/api/v1/classrooms/${fixture.classroomId}/seats`)
      .set(auth(superToken));
    expect(res.status).toBe(409);
  });

  it('deletes an empty unreferenced room', async () => {
    const id = await createRoom();
    const res = await request(app).delete(`/api/v1/classrooms/${id}`).set(auth(superToken));
    expect(res.status).toBe(200);
    expect(await prisma.classroom.findUnique({ where: { id } })).toBeNull();
  });
});
