import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError } from '../../common/errors.js';
import { auditLog } from '../audit/audit.service.js';
import type { CreateAcademicYearInput, UpdateAcademicYearInput } from './academicYears.schemas.js';

export async function listAcademicYears() {
  const items = await prisma.academicYear.findMany({
    orderBy: [{ orderIndex: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { students: true, exams: true } } },
  });
  return { items };
}

export async function createAcademicYear(input: CreateAcademicYearInput, actorId: string, ip: string | null) {
  try {
    const year = await prisma.academicYear.create({ data: input });
    await auditLog({
      actorUserId: actorId,
      action: 'academic_year.create',
      entityType: 'academic_year',
      entityId: year.id,
      metadata: { name: year.name, code: year.code },
      ip,
    });
    return year;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError('An academic year with this name or code already exists');
    }
    throw err;
  }
}

export async function updateAcademicYear(id: string, patch: UpdateAcademicYearInput, actorId: string, ip: string | null) {
  const existing = await prisma.academicYear.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Academic year not found');

  try {
    const year = await prisma.academicYear.update({ where: { id }, data: patch });
    await auditLog({
      actorUserId: actorId,
      action: 'academic_year.update',
      entityType: 'academic_year',
      entityId: id,
      metadata: { changed: Object.keys(patch) },
      ip,
    });
    return year;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError('An academic year with this name or code already exists');
    }
    throw err;
  }
}

export async function deleteAcademicYear(id: string, actorId: string, ip: string | null): Promise<void> {
  const existing = await prisma.academicYear.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Academic year not found');

  const [students, exams, allocations] = await Promise.all([
    prisma.student.count({ where: { academicYearId: id } }),
    prisma.exam.count({ where: { academicYearId: id } }),
    prisma.seatingAllocation.count({ where: { academicYearId: id } }),
  ]);
  if (students > 0 || exams > 0 || allocations > 0) {
    throw new ConflictError(
      `Cannot delete: this year is referenced by ${students} student(s), ${exams} exam(s) and ${allocations} seat allocation(s). Deactivate it instead.`,
    );
  }

  try {
    await prisma.academicYear.delete({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2003' || err.code === 'P2014')) {
      throw new ConflictError('Cannot delete: this academic year is still referenced. Deactivate it instead.');
    }
    throw err;
  }
  await auditLog({
    actorUserId: actorId,
    action: 'academic_year.delete',
    entityType: 'academic_year',
    entityId: id,
    metadata: { name: existing.name, code: existing.code },
    ip,
  });
}
