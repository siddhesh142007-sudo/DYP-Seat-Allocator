import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError } from '../../common/errors.js';
import { auditLog } from '../audit/audit.service.js';
import { parseRoll } from '../dypit/roll.js';
import type { CreateStudentInput, ListStudentsQuery, UpdateStudentInput } from './students.schemas.js';

const STUDENT_INCLUDE = {
  academicYear: { select: { id: true, name: true, code: true } },
  department: { select: { id: true, name: true, code: true } },
  user: { select: { id: true, role: true, status: true } },
} as const;

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

  try {
    const student = await prisma.$transaction(async (tx) => {
      const created = await tx.student.create({
        data: {
          rollNumber: input.rollNumber,
          // Derived from a DYPIT roll number (SE-…, TE-…); null for other formats.
          yearCode: parseRoll(input.rollNumber)?.yearCode ?? null,
          name: input.name,
          email: input.email ?? null,
          division: input.division ?? null,
          status: input.status ?? 'ACTIVE',
          academicYearId: input.academicYearId,
          departmentId: input.departmentId,
        },
      });
      return tx.student.findUniqueOrThrow({ where: { id: created.id }, include: STUDENT_INCLUDE });
    });

    await auditLog({
      actorUserId: actorId,
      action: 'student.create',
      entityType: 'student',
      entityId: student.id,
      metadata: { rollNumber: student.rollNumber },
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
