import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError } from '../../common/errors.js';
import { auditLog } from '../audit/audit.service.js';
import type { CreateDepartmentInput, UpdateDepartmentInput } from './departments.schemas.js';

export async function listDepartments() {
  const items = await prisma.department.findMany({
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { students: true } } },
  });
  return { items };
}

export async function createDepartment(input: CreateDepartmentInput, actorId: string, ip: string | null) {
  try {
    const department = await prisma.department.create({ data: input });
    await auditLog({
      actorUserId: actorId,
      action: 'department.create',
      entityType: 'department',
      entityId: department.id,
      metadata: { name: department.name, code: department.code },
      ip,
    });
    return department;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError('A department with this code already exists');
    }
    throw err;
  }
}

export async function updateDepartment(id: string, patch: UpdateDepartmentInput, actorId: string, ip: string | null) {
  const existing = await prisma.department.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Department not found');

  try {
    const department = await prisma.department.update({ where: { id }, data: patch });
    await auditLog({
      actorUserId: actorId,
      action: 'department.update',
      entityType: 'department',
      entityId: id,
      metadata: { changed: Object.keys(patch) },
      ip,
    });
    return department;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError('A department with this code already exists');
    }
    throw err;
  }
}

export async function deleteDepartment(id: string, actorId: string, ip: string | null): Promise<void> {
  const existing = await prisma.department.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Department not found');

  const [students, allocations] = await Promise.all([
    prisma.student.count({ where: { departmentId: id } }),
    prisma.seatingAllocation.count({ where: { departmentId: id } }),
  ]);
  if (students > 0 || allocations > 0) {
    throw new ConflictError(
      `Cannot delete: this department is referenced by ${students} student(s) and ${allocations} seat allocation(s). Deactivate it instead.`,
    );
  }

  try {
    await prisma.department.delete({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2003' || err.code === 'P2014')) {
      throw new ConflictError('Cannot delete: this department is still referenced. Deactivate it instead.');
    }
    throw err;
  }
  await auditLog({
    actorUserId: actorId,
    action: 'department.delete',
    entityType: 'department',
    entityId: id,
    metadata: { name: existing.name, code: existing.code },
    ip,
  });
}
