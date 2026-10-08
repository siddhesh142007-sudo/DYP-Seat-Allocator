import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError } from '../../common/errors.js';
import { auditLog } from '../audit/audit.service.js';
import { hashPassword } from '../auth/auth.utils.js';
import type { CreateStudentInput, ListStudentsQuery, UpdateStudentInput } from './students.schemas.js';

const STUDENT_INCLUDE = {
  academicYear: { select: { id: true, name: true, code: true } },
  department: { select: { id: true, name: true, code: true } },
  user: { select: { id: true, role: true, status: true } },
} as const;

/**
 * Default password policy for auto-created student logins:
 * "Welcome@<ROLL>" padded with digits to at least 8 characters.
 * The account is flagged mustChangePassword until the student rotates it.
 */
export function defaultPasswordForRoll(rollNumber: string): string {
  let password = `Welcome@${rollNumber}`;
  let pad = 1;
  while (password.length < 8) {
    password += String(pad++ % 10);
  }
  return password;
}

export async function listStudents(query: ListStudentsQuery) {
  const where: Prisma.StudentWhereInput = {
    ...(query.academicYearId ? { academicYearId: query.academicYearId } : {}),
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.division ? { division: { equals: query.division, mode: 'insensitive' } } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { rollNumber: { contains: query.search, mode: 'insensitive' } },
            { email: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.student.findMany({
      where,
      orderBy: { [query.sort]: query.order },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: STUDENT_INCLUDE,
    }),
    prisma.student.count({ where }),
  ]);

  return { items, total, page: query.page, pageSize: query.pageSize };
}

async function assertYearAndDept(academicYearId: string, departmentId: string) {
  const [year, department] = await Promise.all([
    prisma.academicYear.findUnique({ where: { id: academicYearId } }),
    prisma.department.findUnique({ where: { id: departmentId } }),
  ]);
  if (!year) throw new NotFoundError('Academic year not found');
  if (!department) throw new NotFoundError('Department not found');
}

export async function createStudent(input: CreateStudentInput, actorId: string, ip: string | null) {
  await assertYearAndDept(input.academicYearId, input.departmentId);

  const duplicate = await prisma.student.findUnique({ where: { rollNumber: input.rollNumber } });
  if (duplicate) throw new ConflictError('A student with this roll number already exists');

  if (input.createLogin && input.email) {
    const emailClash = await prisma.user.findFirst({ where: { email: { equals: input.email, mode: 'insensitive' } } });
    if (emailClash) throw new ConflictError('A user with this email already exists');
  }

  try {
    const student = await prisma.$transaction(async (tx) => {
      const created = await tx.student.create({
        data: {
          rollNumber: input.rollNumber,
          name: input.name,
          email: input.email ?? null,
          division: input.division ?? null,
          status: input.status ?? 'ACTIVE',
          academicYearId: input.academicYearId,
          departmentId: input.departmentId,
        },
      });
      if (input.createLogin) {
        await tx.user.create({
          data: {
            name: created.name,
            email: created.email,
            role: 'STUDENT',
            status: created.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
            passwordHash: await hashPassword(input.password ?? defaultPasswordForRoll(created.rollNumber)),
            studentId: created.id,
            mustChangePassword: true,
          },
        });
      }
      // Re-read so the `user` include reflects the login created above.
      return tx.student.findUniqueOrThrow({ where: { id: created.id }, include: STUDENT_INCLUDE });
    });

    await auditLog({
      actorUserId: actorId,
      action: 'student.create',
      entityType: 'student',
      entityId: student.id,
      metadata: { rollNumber: student.rollNumber, createLogin: input.createLogin },
      ip,
    });
    return student;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = (err.meta as { target?: string[] } | undefined)?.target?.join(', ');
      if (target?.includes('email')) throw new ConflictError('A user with this email already exists');
      throw new ConflictError('A student with this roll number already exists');
    }
    throw err;
  }
}

export async function updateStudent(id: string, patch: UpdateStudentInput, actorId: string, ip: string | null) {
  const existing = await prisma.student.findUnique({ where: { id }, include: { user: true } });
  if (!existing) throw new NotFoundError('Student not found');

  if (patch.academicYearId || patch.departmentId) {
    await assertYearAndDept(patch.academicYearId ?? existing.academicYearId, patch.departmentId ?? existing.departmentId);
  }

  if (patch.createLogin && !existing.user) {
    if (patch.email) {
      const emailClash = await prisma.user.findFirst({ where: { email: { equals: patch.email, mode: 'insensitive' } } });
      if (emailClash) throw new ConflictError('A user with this email already exists');
    }
  }

  try {
    const student = await prisma.$transaction(async (tx) => {
      await tx.student.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.email !== undefined ? { email: patch.email } : {}),
          ...(patch.division !== undefined ? { division: patch.division } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.academicYearId !== undefined ? { academicYearId: patch.academicYearId } : {}),
          ...(patch.departmentId !== undefined ? { departmentId: patch.departmentId } : {}),
        },
      });

      if (patch.createLogin && !existing.user) {
        await tx.user.create({
          data: {
            name: patch.name ?? existing.name,
            email: patch.email !== undefined ? patch.email : existing.email,
            role: 'STUDENT',
            status: (patch.status ?? existing.status) === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
            passwordHash: await hashPassword(patch.password ?? defaultPasswordForRoll(existing.rollNumber)),
            studentId: existing.id,
            mustChangePassword: true,
          },
        });
      } else if (existing.user && patch.status !== undefined) {
        // Keep the login account in lockstep with the student's status.
        await tx.user.update({ where: { id: existing.user.id }, data: { status: patch.status } });
      }
      // Re-read so the `user` include reflects the login created above.
      return tx.student.findUniqueOrThrow({ where: { id }, include: STUDENT_INCLUDE });
    });

    await auditLog({
      actorUserId: actorId,
      action: 'student.update',
      entityType: 'student',
      entityId: id,
      metadata: { rollNumber: existing.rollNumber, changed: Object.keys(patch) },
      ip,
    });
    return student;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = (err.meta as { target?: string[] } | undefined)?.target?.join(', ');
      if (target?.includes('email')) throw new ConflictError('A user with this email already exists');
      throw new ConflictError('A student with this roll number already exists');
    }
    throw err;
  }
}

/** Soft-delete: the row is kept (seating history FKs) and marked INACTIVE. */
export async function deactivateStudent(id: string, actorId: string, ip: string | null): Promise<void> {
  const existing = await prisma.student.findUnique({ where: { id }, include: { user: true } });
  if (!existing) throw new NotFoundError('Student not found');

  await prisma.$transaction(async (tx) => {
    await tx.student.update({ where: { id }, data: { status: 'INACTIVE' } });
    if (existing.user) {
      await tx.user.update({ where: { id: existing.user.id }, data: { status: 'INACTIVE' } });
    }
  });

  await auditLog({
    actorUserId: actorId,
    action: 'student.deactivate',
    entityType: 'student',
    entityId: id,
    metadata: { rollNumber: existing.rollNumber, hadLogin: Boolean(existing.user) },
    ip,
  });
}
