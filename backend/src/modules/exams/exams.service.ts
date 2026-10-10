import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors.js';
import { auditLog } from '../audit/audit.service.js';
import {
  timeToMinutes,
  type CreateExamInput,
  type ListEligibleQuery,
  type ListExamsQuery,
  type ListRegistrationsQuery,
  type RegistrationStatusInput,
  type UpdateExamInput,
} from './exams.schemas.js';
import { withTransaction } from '../../db/tx.js';

const PLAN_RUN_STATUSES = ['DRAFT', 'VALIDATED', 'PUBLISHED'] as const;

const EXAM_INCLUDE = {
  academicYear: { select: { id: true, name: true, code: true } },
  _count: { select: { registrations: true } },
} as const;

// ---------------------------------------------------------------------------
// Time/date helpers (Prisma maps @db.Time to Date at 1970-01-01 in UTC)
// ---------------------------------------------------------------------------

export function formatTime(value: Date): string {
  return `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}`;
}

export function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function toTimeDate(hhmm: string): Date {
  return new Date(`1970-01-01T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}.000Z`);
}

function toSqlDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

type ExamRow = NonNullable<Awaited<ReturnType<typeof loadExam>>>;

function present(exam: ExamRow & { academicYear?: unknown }) {
  const { academicYear, ...row } = exam as ExamRow & { academicYear?: unknown };
  return {
    id: row.id,
    subject: row.subject,
    paperCode: row.paperCode,
    examDate: formatDate(row.examDate),
    startTime: formatTime(row.startTime),
    endTime: formatTime(row.endTime),
    semester: row.semester,
    status: row.status,
    seatingStatus: row.seatingStatus,
    isStale: row.isStale,
    academicYearId: row.academicYearId,
    academicYear: academicYear ?? undefined,
    ...(row._count ? { registrationCount: row._count.registrations } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function loadExam(id: string) {
  const exam = await prisma.exam.findUnique({ where: { id }, include: EXAM_INCLUDE });
  if (!exam) throw new NotFoundError('Exam not found');
  return exam;
}

async function hasSeatingRuns(examId: string): Promise<boolean> {
  const n = await prisma.seatingRun.count({ where: { examId } });
  return n > 0;
}

/** A usable seating plan exists (any non-failed, non-superseded run). */
async function hasPlan(examId: string): Promise<boolean> {
  const n = await prisma.seatingRun.count({ where: { examId, status: { in: [...PLAN_RUN_STATUSES] } } });
  return n > 0;
}

function eligibleWhere(examId: string, studentExtra: Prisma.StudentWhereInput = {}): Prisma.ExamRegistrationWhereInput {
  return { examId, status: 'REGISTERED', student: { status: 'ACTIVE', ...studentExtra } };
}

// ---------------------------------------------------------------------------
// Time-slot clash helpers
// ---------------------------------------------------------------------------

function timesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  const aS = timeToMinutes(formatTime(aStart));
  const aE = timeToMinutes(formatTime(aEnd));
  const bS = timeToMinutes(formatTime(bStart));
  const bE = timeToMinutes(formatTime(bEnd));
  return aS < bE && bS < aE;
}

interface ClashingExamInfo {
  id: string;
  subject: string;
  examDate: Date;
  startTime: Date;
  endTime: Date;
}

/** Other non-cancelled exams on the same date with an overlapping time slot. */
async function findClashingExams(exam: {
  id: string;
  examDate: Date;
  startTime: Date;
  endTime: Date;
}): Promise<ClashingExamInfo[]> {
  const sameDay = await prisma.exam.findMany({
    where: { id: { not: exam.id }, status: { not: 'CANCELLED' }, examDate: exam.examDate },
    select: { id: true, subject: true, examDate: true, startTime: true, endTime: true },
  });
  return sameDay.filter((o) => timesOverlap(exam.startTime, exam.endTime, o.startTime, o.endTime));
}

// ---------------------------------------------------------------------------
// Exams CRUD
// ---------------------------------------------------------------------------

export async function listExams(query: ListExamsQuery) {
  const where: Prisma.ExamWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.academicYearId ? { academicYearId: query.academicYearId } : {}),
    ...(query.dateFrom || query.dateTo
      ? {
          examDate: {
            ...(query.dateFrom ? { gte: toSqlDate(query.dateFrom) } : {}),
            ...(query.dateTo ? { lte: toSqlDate(query.dateTo) } : {}),
          },
        }
      : {}),
    ...(query.search
      ? {
          OR: [
            { subject: { contains: query.search, mode: 'insensitive' } },
            { paperCode: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.exam.findMany({
      where,
      orderBy: { [query.sort]: query.order },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: EXAM_INCLUDE,
    }),
    prisma.exam.count({ where }),
  ]);

  return { items: items.map(present), total, page: query.page, pageSize: query.pageSize };
}

export async function getExam(id: string) {
  const exam = await loadExam(id);

  const [grouped, eligibleCount] = await Promise.all([
    prisma.examRegistration.groupBy({ by: ['status'], where: { examId: id }, _count: true }),
    prisma.examRegistration.count({ where: eligibleWhere(id, { academicYearId: exam.academicYearId }) }),
  ]);

  const registrationCounts: Record<string, number> = { REGISTERED: 0, ABSENT: 0, WITHHELD: 0, REMOVED: 0 };
  for (const g of grouped) registrationCounts[g.status] = g._count;

  return { exam: { ...present(exam), registrationCounts, eligibleCount } };
}

export async function createExam(input: CreateExamInput, actorId: string, ip: string | null) {
  const year = await prisma.academicYear.findUnique({ where: { id: input.academicYearId } });
  if (!year) throw new NotFoundError('Academic year not found');

  const exam = await withTransaction(async (tx) => {
    const created = await tx.exam.create({
      data: {
        subject: input.subject,
        paperCode: input.paperCode ?? null,
        examDate: toSqlDate(input.examDate),
        startTime: toTimeDate(input.startTime),
        endTime: toTimeDate(input.endTime),
        semester: input.semester ?? null,
        status: input.status ?? 'PLANNED',
        academicYearId: input.academicYearId,
      },
    });

    if (input.autoRegister) {
      const students = await tx.student.findMany({
        where: { academicYearId: input.academicYearId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (students.length > 0) {
        await tx.examRegistration.createMany({
          data: students.map((s) => ({ examId: created.id, studentId: s.id })),
          skipDuplicates: true,
        });
      }
    }

    return tx.exam.findUniqueOrThrow({ where: { id: created.id }, include: { ...EXAM_INCLUDE, _count: { select: { registrations: true } } } });
  });

  await auditLog({
    actorUserId: actorId,
    action: 'exam.create',
    entityType: 'exam',
    entityId: exam.id,
    metadata: {
      subject: exam.subject,
      examDate: formatDate(exam.examDate),
      autoRegister: input.autoRegister,
      registeredCount: exam._count.registrations,
    },
    ip,
  });

  return { exam: present(exam) };
}

export async function updateExam(id: string, patch: UpdateExamInput, actorId: string, ip: string | null) {
  const exam = await loadExam(id);

  if (exam.seatingStatus === 'PUBLISHED') {
    const scheduleChanging =
      (patch.examDate !== undefined && patch.examDate !== formatDate(exam.examDate)) ||
      (patch.startTime !== undefined && patch.startTime !== formatTime(exam.startTime)) ||
      (patch.endTime !== undefined && patch.endTime !== formatTime(exam.endTime)) ||
      patch.academicYearId !== undefined;

    if (scheduleChanging) {
      throw new ConflictError(
        'The exam schedule cannot be modified while a seating plan is published. Unpublish the plan first (SUPER_ADMIN only), then edit examDate/startTime/endTime/academicYear and regenerate/re-publish.'
      );
    }
  }

  const effStartTime = patch.startTime ? patch.startTime : formatTime(exam.startTime);
  const effEndTime = patch.endTime ? patch.endTime : formatTime(exam.endTime);
  if (timeToMinutes(effEndTime) <= timeToMinutes(effStartTime)) {
    throw new ValidationError('endTime must be after startTime', { startTime: effStartTime, endTime: effEndTime });
  }

  const yearChanging = patch.academicYearId !== undefined && patch.academicYearId !== exam.academicYearId;
  const planExists = await hasPlan(id);
  if (yearChanging && planExists) {
    throw new ConflictError('The academic year cannot be changed after a seating plan has been generated.');
  }

  const scheduleChanged =
    (patch.examDate !== undefined && patch.examDate !== formatDate(exam.examDate)) ||
    (patch.startTime !== undefined && patch.startTime !== formatTime(exam.startTime)) ||
    (patch.endTime !== undefined && patch.endTime !== formatTime(exam.endTime)) ||
    yearChanging;

  const updated = await withTransaction(async (tx) => {
    await tx.exam.update({
      where: { id },
      data: {
        ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
        ...(patch.paperCode !== undefined ? { paperCode: patch.paperCode } : {}),
        ...(patch.examDate !== undefined ? { examDate: toSqlDate(patch.examDate) } : {}),
        ...(patch.startTime !== undefined ? { startTime: toTimeDate(patch.startTime) } : {}),
        ...(patch.endTime !== undefined ? { endTime: toTimeDate(patch.endTime) } : {}),
        ...(patch.semester !== undefined ? { semester: patch.semester } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.academicYearId !== undefined ? { academicYearId: patch.academicYearId } : {}),
        ...(scheduleChanged && planExists ? { isStale: true } : {}),
      },
    });

    if (yearChanging) {
      // Re-sync registrations to the new year's ACTIVE students.
      await tx.examRegistration.deleteMany({ where: { examId: id } });
      const students = await tx.student.findMany({
        where: { academicYearId: patch.academicYearId!, status: 'ACTIVE' },
        select: { id: true },
      });
      if (students.length > 0) {
        await tx.examRegistration.createMany({
          data: students.map((s) => ({ examId: id, studentId: s.id })),
          skipDuplicates: true,
        });
      }
    }

    return tx.exam.findUniqueOrThrow({ where: { id }, include: EXAM_INCLUDE });
  });

  await auditLog({
    actorUserId: actorId,
    action: 'exam.update',
    entityType: 'exam',
    entityId: id,
    metadata: { changed: Object.keys(patch), scheduleChanged, yearChanging },
    ip,
  });

  return { exam: present(updated) };
}

export async function deleteExam(id: string, actorId: string, ip: string | null) {
  const exam = await loadExam(id);
  if (await hasSeatingRuns(id)) {
    throw new ConflictError('This exam has seating runs and cannot be deleted. Cancel the exam instead.');
  }

  await prisma.exam.delete({ where: { id } });

  await auditLog({
    actorUserId: actorId,
    action: 'exam.delete',
    entityType: 'exam',
    entityId: id,
    metadata: { subject: exam.subject, examDate: formatDate(exam.examDate) },
    ip,
  });

  return { message: 'Exam deleted' };
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

function presentRegistration(reg: {
  id: string;
  examId: string;
  studentId: string;
  status: string;
  registeredAt: Date;
  student?: Record<string, unknown>;
}) {
  return {
    id: reg.id,
    examId: reg.examId,
    studentId: reg.studentId,
    status: reg.status,
    registeredAt: reg.registeredAt,
    student: reg.student,
  };
}

export async function listRegistrations(examId: string, query: ListRegistrationsQuery) {
  await loadExam(examId);

  const studentWhere: Prisma.StudentWhereInput = {
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.division ? { division: { equals: query.division, mode: 'insensitive' } } : {}),
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

  const where: Prisma.ExamRegistrationWhereInput = {
    examId,
    ...(query.status ? { status: query.status } : {}),
    ...(Object.keys(studentWhere).length > 0 ? { student: studentWhere } : {}),
  };

  const orderBy:
    | Prisma.ExamRegistrationOrderByWithRelationInput
    | Prisma.ExamRegistrationOrderByWithRelationInput[] =
    query.sort === 'name' || query.sort === 'rollNumber'
      ? { student: { [query.sort]: query.order } }
      : { [query.sort]: query.order };

  const [items, total] = await Promise.all([
    prisma.examRegistration.findMany({
      where,
      orderBy,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        student: {
          select: {
            id: true,
            rollNumber: true,
            name: true,
            email: true,
            division: true,
            status: true,
            department: { select: { id: true, name: true, code: true } },
            academicYear: { select: { id: true, name: true, code: true } },
          },
        },
      },
    }),
    prisma.examRegistration.count({ where }),
  ]);

  return { items: items.map(presentRegistration), total, page: query.page, pageSize: query.pageSize };
}

export async function setRegistrationStatus(
  examId: string,
  studentId: string,
  status: RegistrationStatusInput,
  actorId: string,
  ip: string | null,
) {
  const exam = await loadExam(examId);
  const reg = await prisma.examRegistration.findUnique({ where: { examId_studentId: { examId, studentId } } });
  if (!reg) throw new NotFoundError('Registration not found for this student');

  let isStale = exam.isStale;
  if (reg.status !== status) {
    const planExists = await hasPlan(examId);
    isStale = await withTransaction(async (tx) => {
      await tx.examRegistration.update({ where: { id: reg.id }, data: { status } });
      if (planExists) {
        await tx.exam.update({ where: { id: examId }, data: { isStale: true } });
        return true;
      }
      return exam.isStale;
    });

    const student = await prisma.student.findUnique({ where: { id: studentId }, select: { rollNumber: true, name: true } });
    await auditLog({
      actorUserId: actorId,
      action: 'exam.registration.update',
      entityType: 'exam_registration',
      entityId: reg.id,
      metadata: { examId, rollNumber: student?.rollNumber, from: reg.status, to: status },
      ip,
    });
  }

  return {
    registration: presentRegistration({ ...reg, status }),
    examIsStale: isStale,
  };
}

export async function addRegistration(
  examId: string,
  studentId: string,
  actorId: string,
  ip: string | null,
) {
  const exam = await loadExam(examId);
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw new NotFoundError('Student not found');
  if (student.status !== 'ACTIVE') throw new ValidationError('Only ACTIVE students can be registered for an exam');
  if (student.academicYearId !== exam.academicYearId) {
    throw new ValidationError('Student belongs to a different academic year than this exam', {
      studentAcademicYearId: student.academicYearId,
      examAcademicYearId: exam.academicYearId,
    });
  }

  const existing = await prisma.examRegistration.findUnique({ where: { examId_studentId: { examId, studentId } } });
  if (existing && existing.status === 'REGISTERED') {
    throw new ConflictError('Student is already registered for this exam');
  }

  const reg = await withTransaction(async (tx) => {
    const created = existing
      ? await tx.examRegistration.update({ where: { id: existing.id }, data: { status: 'REGISTERED' } })
      : await tx.examRegistration.create({ data: { examId, studentId, status: 'REGISTERED' } });
    return created;
  });

  const planExists = await hasPlan(examId);
  if (planExists) await prisma.exam.update({ where: { id: examId }, data: { isStale: true } });

  await auditLog({
    actorUserId: actorId,
    action: 'exam.registration.add',
    entityType: 'exam_registration',
    entityId: reg.id,
    metadata: { examId, rollNumber: student.rollNumber, reactivated: Boolean(existing) },
    ip,
  });

  return {
    registration: presentRegistration({
      ...reg,
      student: {
        id: student.id,
        rollNumber: student.rollNumber,
        name: student.name,
        email: student.email,
        division: student.division,
        status: student.status,
      },
    }),
    examIsStale: planExists,
  };
}

// ---------------------------------------------------------------------------
// Eligible students & preview stats
// ---------------------------------------------------------------------------

export async function listEligibleStudents(examId: string, query: ListEligibleQuery) {
  const exam = await loadExam(examId);

  const where: Prisma.ExamRegistrationWhereInput = eligibleWhere(examId, {
    academicYearId: exam.academicYearId,
    ...(query.departmentId ? { departmentId: query.departmentId } : {}),
    ...(query.division ? { division: { equals: query.division, mode: 'insensitive' } } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' } },
            { rollNumber: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  });

  const [items, total] = await Promise.all([
    prisma.examRegistration.findMany({
      where,
      orderBy: { student: { [query.sort]: query.order } },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        student: {
          select: {
            id: true,
            rollNumber: true,
            name: true,
            division: true,
            status: true,
            department: { select: { id: true, name: true, code: true } },
            academicYear: { select: { id: true, name: true, code: true } },
          },
        },
      },
    }),
    prisma.examRegistration.count({ where }),
  ]);

  return { items: items.map(presentRegistration), total, page: query.page, pageSize: query.pageSize };
}

export async function seatingPreviewStats(examId: string) {
  const exam = await loadExam(examId);

  const [eligibleRows, clashing, sameDayRooms] = await Promise.all([
    prisma.examRegistration.findMany({
      where: eligibleWhere(examId, { academicYearId: exam.academicYearId }),
      select: { student: { select: { departmentId: true, department: { select: { id: true, code: true, name: true } } } } },
    }),
    findClashingExams(exam),
    prisma.classroom.findMany({ where: { status: 'AVAILABLE' }, select: { id: true, roomNumber: true, building: true } }),
  ]);
  const eligibleCount = eligibleRows.length;

  // Departments breakdown of eligible students.
  const deptCounts = new Map<string, { code: string; name: string; count: number }>();
  const zeroDepartments = await prisma.department.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, code: true, name: true },
  });
  for (const d of zeroDepartments) deptCounts.set(d.id, { code: d.code, name: d.name, count: 0 });
  for (const row of eligibleRows) {
    const dept = row.student.department;
    if (!dept) continue;
    const bucket = deptCounts.get(dept.id) ?? { code: dept.code, name: dept.name, count: 0 };
    bucket.count += 1;
    deptCounts.set(dept.id, bucket);
  }
  const departmentsBreakdown = [...deptCounts.values()]
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count);

  // Rooms blocked by clashing exams that already have a seating plan.
  const clashIds = clashing.map((c) => c.id);
  const [planRunsByExam, allocationRows] = await Promise.all([
    clashIds.length > 0
      ? prisma.seatingRun.groupBy({
          by: ['examId'],
          where: { examId: { in: clashIds }, status: { in: [...PLAN_RUN_STATUSES] } },
          _count: true,
        })
      : Promise.resolve([]),
    clashIds.length > 0
      ? prisma.seatingAllocation.findMany({
          where: { examId: { in: clashIds }, run: { status: { in: [...PLAN_RUN_STATUSES] } } },
          select: { classroomId: true, examId: true },
        })
      : Promise.resolve([]),
  ]);

  const planExamIds = new Set(planRunsByExam.map((r) => r.examId));
  const roomMeta = new Map(sameDayRooms.map((r) => [r.id, r]));
  const blockedByExam = new Map<string, Set<string>>();
  const blockedRoomIds = new Set<string>();
  for (const row of allocationRows) {
    blockedRoomIds.add(row.classroomId);
    const set = blockedByExam.get(row.examId) ?? new Set<string>();
    set.add(row.classroomId);
    blockedByExam.set(row.examId, set);
  }

  const roomsBlockedByOtherExams = {
    count: blockedRoomIds.size,
    rooms: [...blockedRoomIds].map((id) => {
      const room = roomMeta.get(id);
      const blockingExamId = allocationRows.find((r) => r.classroomId === id)?.examId;
      const blocking = clashing.find((c) => c.id === blockingExamId);
      return {
        classroomId: id,
        roomNumber: room?.roomNumber ?? null,
        building: room?.building ?? null,
        blockingExamId,
        blockingSubject: blocking?.subject ?? null,
      };
    }),
  };

  // Available room pool: AVAILABLE rooms not blocked by a clashing exam's plan.
  const poolRooms = sameDayRooms.filter((r) => !blockedRoomIds.has(r.id));
  const seatCounts =
    poolRooms.length > 0
      ? await prisma.seat.groupBy({
          by: ['classroomId'],
          where: { classroomId: { in: poolRooms.map((r) => r.id) }, status: 'AVAILABLE' },
          _count: true,
        })
      : [];
  const seatsByRoom = new Map(seatCounts.map((s) => [s.classroomId, s._count]));
  const roomPool = poolRooms
    .map((r) => ({ ...r, availableSeats: seatsByRoom.get(r.id) ?? 0 }))
    .filter((r) => r.availableSeats > 0)
    .sort((a, b) => b.availableSeats - a.availableSeats);

  const availableSeats = roomPool.reduce((sum, r) => sum + r.availableSeats, 0);

  // Greedy largest-first: minimum rooms needed to seat every eligible student.
  let classroomsRequired = 0;
  let acc = 0;
  for (const room of roomPool) {
    if (acc >= eligibleCount) break;
    acc += room.availableSeats;
    classroomsRequired += 1;
  }
  if (eligibleCount === 0) classroomsRequired = 0;

  const conflicts: { code: string; message: string; details?: Record<string, unknown> }[] = [];
  if (eligibleCount === 0) {
    conflicts.push({ code: 'NO_ELIGIBLE_STUDENTS', message: 'No active registered students for this exam.' });
  }
  if (roomPool.length === 0) {
    conflicts.push({
      code: 'NO_AVAILABLE_ROOMS',
      message: 'No available classrooms with usable seats.',
      details: { availableRooms: 0, blockedRooms: blockedRoomIds.size },
    });
  } else if (availableSeats < eligibleCount) {
    conflicts.push({
      code: 'INSUFFICIENT_SEATS',
      message: `Not enough seats: ${eligibleCount} students need seats but only ${availableSeats} are available.`,
      details: { eligibleCount, availableSeats, shortfall: eligibleCount - availableSeats },
    });
  }
  if (clashing.length > 0) {
    conflicts.push({
      code: 'CLASHING_EXAM_SLOT',
      message: `${clashing.length} other exam(s) overlap this time slot.`,
      details: {
        exams: clashing.map((c) => ({
          id: c.id,
          subject: c.subject,
          examDate: formatDate(c.examDate),
          startTime: formatTime(c.startTime),
          endTime: formatTime(c.endTime),
          hasSeatingPlan: planExamIds.has(c.id),
          blockedRooms: blockedByExam.get(c.id)?.size ?? 0,
        })),
      },
    });
  }

  return {
    examId,
    eligibleCount,
    availableSeats,
    availableRooms: roomPool.length,
    classroomsRequired,
    departmentsBreakdown,
    roomsBlockedByOtherExams,
    conflicts,
  };
}
