import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors.js';
import { auditLog } from '../audit/audit.service.js';
import { hashPassword } from '../auth/auth.utils.js';
import { publicUser } from '../auth/auth.service.js';
import type { CreateUserInput, ListUsersQuery, UpdateUserInput } from './users.schemas.js';

const STUDENT_INCLUDE = { student: { select: { id: true, rollNumber: true, name: true } } } as const;

export async function listUsers(query: ListUsersQuery) {
  const where: Prisma.UserWhereInput = {
    ...(query.role ? { role: query.role } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { email: { contains: query.search, mode: 'insensitive' } },
            { student: { rollNumber: { contains: query.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: STUDENT_INCLUDE,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    items: items.map((u) => ({ ...publicUser(u), student: u.student })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function createUser(input: CreateUserInput, actorId: string, ip: string | null) {
  if (input.email) {
    const existing = await prisma.user.findFirst({ where: { email: { equals: input.email, mode: 'insensitive' } } });
    if (existing) throw new ConflictError('A user with this email already exists');
  }

  if (input.studentId) {
    const student = await prisma.student.findUnique({ where: { id: input.studentId } });
    if (!student) throw new NotFoundError('Student not found');
    const linked = await prisma.user.findUnique({ where: { studentId: input.studentId } });
    if (linked) throw new ConflictError('This student already has a login user');
  }

  let user;
  try {
    user = await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        role: input.role,
        status: input.status ?? 'ACTIVE',
        passwordHash: await hashPassword(input.password),
        studentId: input.studentId,
      },
      include: STUDENT_INCLUDE,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError('A user with this email already exists');
    }
    throw err;
  }

  await auditLog({
    actorUserId: actorId,
    action: 'user.create',
    entityType: 'user',
    entityId: user.id,
    metadata: { email: user.email, role: user.role },
    ip,
  });
  return { ...publicUser(user), student: user.student };
}

export async function updateUser(id: string, patch: UpdateUserInput, actorId: string, ip: string | null) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User not found');

  if (actorId === id && ('role' in patch || 'status' in patch)) {
    throw new ForbiddenError('You cannot change your own role or status');
  }

  if (patch.email) {
    const clash = await prisma.user.findFirst({
      where: { email: { equals: patch.email, mode: 'insensitive' }, NOT: { id } },
    });
    if (clash) throw new ConflictError('A user with this email already exists');
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    },
    include: STUDENT_INCLUDE,
  });

  await auditLog({
    actorUserId: actorId,
    action: 'user.update',
    entityType: 'user',
    entityId: id,
    metadata: { changed: Object.keys(patch), role: updated.role, status: updated.status },
    ip,
  });
  return { ...publicUser(updated), student: updated.student };
}

export async function deleteUser(id: string, actorId: string, ip: string | null): Promise<void> {
  if (id === actorId) throw new ForbiddenError('You cannot delete your own account');

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError('User not found');

  if (user.role === 'SUPER_ADMIN' && user.status === 'ACTIVE') {
    const activeSuperAdmins = await prisma.user.count({ where: { role: 'SUPER_ADMIN', status: 'ACTIVE' } });
    if (activeSuperAdmins <= 1) throw new ForbiddenError('Cannot delete the last active SUPER_ADMIN');
  }

  await auditLog({
    actorUserId: actorId,
    action: 'user.delete',
    entityType: 'user',
    entityId: id,
    metadata: { name: user.name, email: user.email, role: user.role },
    ip,
  });
  await prisma.user.delete({ where: { id } });
}
