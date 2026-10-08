import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError } from '../../common/errors.js';
import { auditLog } from '../audit/audit.service.js';
import type {
  CreateClassroomInput,
  GenerateSeatsInput,
  ListClassroomsQuery,
  UpdateClassroomInput,
} from './classrooms.schemas.js';

type SeatCountMap = Map<string, { total: number; available: number }>;

async function seatCounts(classroomIds?: string[]): Promise<SeatCountMap> {
  const where = classroomIds ? { classroomId: { in: classroomIds } } : {};
  const grouped = await prisma.seat.groupBy({ by: ['classroomId', 'status'], where, _count: true });
  const map: SeatCountMap = new Map();
  for (const row of grouped) {
    const entry = map.get(row.classroomId) ?? { total: 0, available: 0 };
    entry.total += row._count;
    if (row.status === 'AVAILABLE') entry.available += row._count;
    map.set(row.classroomId, entry);
  }
  return map;
}

export async function listClassrooms(query: ListClassroomsQuery) {
  const where: Prisma.ClassroomWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          OR: [
            { roomNumber: { contains: query.search, mode: 'insensitive' } },
            { building: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.classroom.findMany({
      where,
      orderBy: { roomNumber: 'asc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.classroom.count({ where }),
  ]);

  const counts = await seatCounts(items.map((c) => c.id));
  return {
    items: items.map((c) => ({
      ...c,
      totalSeats: counts.get(c.id)?.total ?? 0,
      availableSeats: counts.get(c.id)?.available ?? 0,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function getClassroom(id: string) {
  const classroom = await prisma.classroom.findUnique({ where: { id } });
  if (!classroom) throw new NotFoundError('Classroom not found');
  const seats = await prisma.seat.findMany({ where: { classroomId: id }, orderBy: { benchNumber: 'asc' } });
  return { ...classroom, totalSeats: seats.length, availableSeats: seats.filter((s) => s.status === 'AVAILABLE').length, seats };
}

export async function createClassroom(input: CreateClassroomInput, actorId: string, ip: string | null) {
  try {
    const classroom = await prisma.classroom.create({ data: input });
    await auditLog({
      actorUserId: actorId,
      action: 'classroom.create',
      entityType: 'classroom',
      entityId: classroom.id,
      metadata: { roomNumber: classroom.roomNumber },
      ip,
    });
    return classroom;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError('A classroom with this room number already exists');
    }
    throw err;
  }
}

export async function updateClassroom(id: string, patch: UpdateClassroomInput, actorId: string, ip: string | null) {
  const existing = await prisma.classroom.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Classroom not found');

  try {
    const classroom = await prisma.classroom.update({ where: { id }, data: patch });
    await auditLog({
      actorUserId: actorId,
      action: 'classroom.update',
      entityType: 'classroom',
      entityId: id,
      metadata: { changed: Object.keys(patch) },
      ip,
    });
    return classroom;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError('A classroom with this room number already exists');
    }
    throw err;
  }
}

export async function deleteClassroom(id: string, actorId: string, ip: string | null): Promise<void> {
  const existing = await prisma.classroom.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('Classroom not found');

  const allocations = await prisma.seatingAllocation.count({ where: { classroomId: id } });
  if (allocations > 0) {
    throw new ConflictError(
      `This room has seating history (${allocations} allocation(s)). Mark it unavailable instead of deleting.`,
    );
  }

  try {
    await prisma.classroom.delete({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2003' || err.code === 'P2014')) {
      throw new ConflictError('Cannot delete: this classroom is still referenced. Mark it unavailable instead.');
    }
    throw err;
  }
  await auditLog({
    actorUserId: actorId,
    action: 'classroom.delete',
    entityType: 'classroom',
    entityId: id,
    metadata: { roomNumber: existing.roomNumber },
    ip,
  });
}

export async function generateSeats(id: string, input: GenerateSeatsInput, actorId: string, ip: string | null) {
  const classroom = await prisma.classroom.findUnique({ where: { id }, include: { _count: { select: { seats: true } } } });
  if (!classroom) throw new NotFoundError('Classroom not found');
  if (classroom._count.seats > 0) {
    throw new ConflictError(`This room already has ${classroom._count.seats} bench(es). Clear them before generating.`);
  }

  const seats = Array.from({ length: input.count }, (_, i) => {
    const benchNumber = i + 1;
    const hasLayout = input.rows != null && input.cols != null;
    return {
      classroomId: id,
      benchNumber,
      ...(hasLayout
        ? { rowNo: Math.floor(i / input.cols!) + 1, colNo: (i % input.cols!) + 1 }
        : {}),
    };
  });

  await prisma.seat.createMany({ data: seats });
  await auditLog({
    actorUserId: actorId,
    action: 'classroom.generate_seats',
    entityType: 'classroom',
    entityId: id,
    metadata: { roomNumber: classroom.roomNumber, count: input.count, rows: input.rows ?? null, cols: input.cols ?? null },
    ip,
  });
  return getClassroom(id);
}

export async function clearSeats(id: string, actorId: string, ip: string | null) {
  const classroom = await prisma.classroom.findUnique({ where: { id } });
  if (!classroom) throw new NotFoundError('Classroom not found');

  const used = await prisma.seatingAllocation.count({ where: { classroomId: id } });
  if (used > 0) {
    throw new ConflictError(`Cannot clear benches: ${used} seat allocation(s) reference this room.`);
  }

  const { count } = await prisma.seat.deleteMany({ where: { classroomId: id } });
  await auditLog({
    actorUserId: actorId,
    action: 'classroom.clear_seats',
    entityType: 'classroom',
    entityId: id,
    metadata: { roomNumber: classroom.roomNumber, cleared: count },
    ip,
  });
  return getClassroom(id);
}

export async function updateSeat(classroomId: string, seatId: string, status: 'AVAILABLE' | 'DISABLED', actorId: string, ip: string | null) {
  const seat = await prisma.seat.findUnique({ where: { id: seatId } });
  if (!seat || seat.classroomId !== classroomId) throw new NotFoundError('Seat not found');

  const updated = await prisma.seat.update({ where: { id: seatId }, data: { status } });
  // classroom.capacity is maintained by a DB trigger on the seats table.
  await auditLog({
    actorUserId: actorId,
    action: 'classroom.seat.update',
    entityType: 'seat',
    entityId: seatId,
    metadata: { classroomId, benchNumber: seat.benchNumber, status },
    ip,
  });
  return updated;
}
