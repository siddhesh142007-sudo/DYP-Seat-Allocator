import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type pg from 'pg';

export interface TestUserSpec {
  role: 'SUPER_ADMIN' | 'EXAM_ADMIN' | 'STUDENT';
  password: string;
  name?: string;
  /** null = no email; undefined = generated unique test email */
  email?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
  studentId?: string | null;
}

export interface TestUser {
  id: string;
  email: string | null;
  password: string;
}

export async function createTestUser(pool: pg.Pool, spec: TestUserSpec): Promise<TestUser> {
  const id = randomUUID();
  const email =
    spec.email === undefined ? `${spec.role.toLowerCase()}_${id.slice(0, 8)}@test.local` : spec.email;
  const passwordHash = await bcrypt.hash(spec.password, 12);
  await pool.query(
    `INSERT INTO users (id, email, name, role, password_hash, status, student_id, token_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
    [id, email, spec.name ?? `Test ${spec.role}`, spec.role, passwordHash, spec.status ?? 'ACTIVE', spec.studentId ?? null],
  );
  return { id, email, password: spec.password };
}

/** Creates an academic year, a department and a student linked to them. */
export async function createTestStudent(
  pool: pg.Pool,
  opts: { rollPrefix?: string } = {},
): Promise<{ id: string; rollNumber: string }> {
  const suffix = randomUUID().slice(0, 8);
  const yearId = randomUUID();
  await pool.query(
    `INSERT INTO academic_years (id, name, code, order_index, status)
     VALUES ($1, $2, $3, 1, 'ACTIVE')`,
    [yearId, `Auth Year ${suffix}`, `AY${suffix}`],
  );
  const deptId = randomUUID();
  await pool.query(
    `INSERT INTO departments (id, name, code, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [deptId, `Auth Dept ${suffix}`, `AD${suffix}`],
  );
  const id = randomUUID();
  const rollNumber = `${opts.rollPrefix ?? 'AU'}${suffix}`;
  await pool.query(
    `INSERT INTO students (id, roll_number, name, status, academic_year_id, department_id)
     VALUES ($1, $2, $3, 'ACTIVE', $4, $5)`,
    [id, rollNumber, `Auth Student ${suffix}`, yearId, deptId],
  );
  return { id, rollNumber };
}
