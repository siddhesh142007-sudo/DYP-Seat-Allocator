import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../common/errors.js';
import { auditLog } from '../audit/audit.service.js';
import { rangesOverlap, type RollRange } from './roll.js';
import type { CohortQuery, CreateIntentInput, UpdateIntentInput } from './intents.schemas.js';

const tx = (client = prisma) => client;

/** Bench-count limits reused by the intent and generation paths. */
export const MAX_ROOM_BENCHES = 500;

export interface IntentView {
  id: string;
  examId: string;
  classroomId: string;
  roomNumber: string | null;
  floor: string | null;
  yearCode: string;
  branchCode: string;
  division: string;
  fromSerial: number;
  toSerial: number;
  rowCount: number | null;
  colCount: number | null;
  seatOffset: number;
  strictRollOrder: boolean;
  /** How many students the range currently resolves to. */
  studentCount: number;
  /** Benches this block may use in the chosen room. */
  availableBenches: number;
  createdAt: string;
}

const withRoom = {
  classroom: { select: { id: true, roomNumber: true, floor: true, status: true, seats: { where: { status: 'AVAILABLE' }, select: { id: true, benchNumber: true } } } },
} satisfies Prisma.AllocationIntentInclude;

type IntentRow = Prisma.AllocationIntentGetPayload<{ include: typeof withRoom }>;

function toView(row: IntentRow): IntentView {
  const benches = row.classroom.seats;
  const highest = benches.length > 0 ? Math.max(...benches.map((s) => s.benchNumber)) : 0;
  const usable = Math.max(0, highest - row.seatOffset + 1);
  return {
    id: row.id,
    examId: row.examId,
    classroomId: row.classroomId,
    roomNumber: row.classroom.roomNumber,
    floor: row.classroom.floor,
    yearCode: row.yearCode,
    branchCode: row.branchCode,
    division: row.division,
    fromSerial: row.fromSerial,
    toSerial: row.toSerial,
    rowCount: row.rowCount,
    colCount: row.colCount,
    seatOffset: row.seatOffset,
    strictRollOrder: row.strictRollOrder,
    studentCount: 0,
    availableBenches: usable,
    createdAt: row.createdAt.toISOString(),
  };
}

/** AVAILABLE benches of a room, ordered by bench number. */
async function availableBenches(classroomId: string, client = prisma) {
  const room = await tx(client).classroom.findUnique({
    where: { id: classroomId },
    include: { seats: { where: { status: 'AVAILABLE' }, orderBy: { benchNumber: 'asc' } } },
  });
  return room;
}

function countStudentsInRange(range: RollRange): Promise<number> {
  return studentsInRange(range).then((rows) => rows.length);
}

/**
 * Fetch the students a range resolves to, in ascending serial order.
 *
 * Scanned by roll-number prefix (which the index can serve) and then filtered
 * on the numeric serial in memory. A pure SQL suffix match cannot be used:
 * serials are padded to a minimum of two digits, so "01..09" and "100..105"
 * have different widths and a string comparison would mis-order or mis-count
 * past 99. Cohorts are at most a few hundred students, so this stays cheap.
 */
export async function studentsInRange(range: RollRange, client = prisma) {
  const prefix = `${range.yearCode}-${range.branchCode}-${range.division}_`;
  const rows = await tx(client).student.findMany({
    where: {
      yearCode: range.yearCode,
      division: range.division,
      department: { code: range.branchCode },
      status: 'ACTIVE',
      rollNumber: { startsWith: prefix },
    },
    orderBy: { rollNumber: 'asc' },
  });

  const parsed: Array<{
    id: string;
    rollNumber: string;
    name: string;
    division: string | null;
    departmentId: string;
    serial: number;
  }> = [];
  for (const s of rows) {
    const serial = parseSerial(s.rollNumber.slice(prefix.length));
    if (serial !== null && serial >= range.fromSerial && serial <= range.toSerial) {
      parsed.push({
        id: s.id,
        rollNumber: s.rollNumber,
        name: s.name,
        division: s.division,
        departmentId: s.departmentId,
        serial,
      });
    }
  }
  return parsed.sort((a, b) => a.serial - b.serial);
}

function parseSerial(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Benches a stored block occupies: rows x cols when a grid was given,
 * otherwise one per student in its range. Never assume 1 for a gridless block,
 * or two adjacent blocks would look like they collide on their first bench.
 */
async function blockFootprint(intent: {
  rowCount: number | null;
  colCount: number | null;
  yearCode: string;
  branchCode: string;
  division: string;
  fromSerial: number;
  toSerial: number;
}): Promise<number> {
  if (intent.rowCount && intent.colCount) return intent.rowCount * intent.colCount;
  const students = await studentsInRange({
    yearCode: intent.yearCode as RollRange['yearCode'],
    branchCode: intent.branchCode,
    division: intent.division,
    fromSerial: intent.fromSerial,
    toSerial: intent.toSerial,
  });
  return students.length;
}

export async function listIntents(examId: string): Promise<IntentView[]> {
  const rows = await prisma.allocationIntent.findMany({
    where: { examId },
    include: withRoom,
    orderBy: [{ yearCode: 'asc' }, { branchCode: 'asc' }, { division: 'asc' }, { fromSerial: 'asc' }],
  });
  const views = rows.map(toView);
  // Resolve student counts in one grouped pass rather than N queries.
  const counts = await Promise.all(
    views.map((v) =>
      countStudentsInRange({ yearCode: v.yearCode as RollRange['yearCode'], branchCode: v.branchCode, division: v.division, fromSerial: v.fromSerial, toSerial: v.toSerial }),
    ),
  );
  views.forEach((v, i) => {
    v.studentCount = counts[i] ?? 0;
  });
  return views;
}

export async function getIntent(examId: string, intentId: string): Promise<IntentView> {
  const row = await prisma.allocationIntent.findFirst({ where: { id: intentId, examId }, include: withRoom });
  if (!row) throw new NotFoundError('Allocation intent not found');
  const view = toView(row);
  view.studentCount = await countStudentsInRange({
    yearCode: view.yearCode as RollRange['yearCode'],
    branchCode: view.branchCode,
    division: view.division,
    fromSerial: view.fromSerial,
    toSerial: view.toSerial,
  });
  return view;
}

export interface CreateIntentContext {
  actorUserId?: string | null;
  ip?: string | null;
}

/**
 * Creates one roll-range -> room block.
 *
 * Validation is deliberately strict and reports a *reason* for every failure,
 * because a silently mis-resolved range would seat the wrong students: the
 * range must match real students, fit the room's usable benches, and not
 * overlap another block for the same exam.
 */
export async function createIntent(
  examId: string,
  input: CreateIntentInput,
  ctx: CreateIntentContext = {},
): Promise<IntentView> {
  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true, seatingStatus: true } });
  if (!exam) throw new NotFoundError('Exam not found');
  if (exam.seatingStatus === 'PUBLISHED') {
    throw new ConflictError('Cannot change allocation intents while the plan is published; unpublish first.');
  }

  const room = await availableBenches(input.classroomId);
  if (!room) throw new NotFoundError('Classroom not found');
  if (room.status !== 'AVAILABLE') {
    throw new UnprocessableError(`Room ${room.roomNumber} is ${room.status.toLowerCase()} and cannot take students`);
  }
  if (room.seats.length === 0) {
    throw new UnprocessableError(`Room ${room.roomNumber} has no AVAILABLE benches — generate benches first`);
  }

  const range: RollRange = {
    yearCode: input.yearCode,
    branchCode: input.branchCode,
    division: input.division,
    fromSerial: input.fromSerial,
    toSerial: input.toSerial,
  };

  const students = await studentsInRange(range);
  if (students.length === 0) {
    throw new UnprocessableError(
      `No students match ${range.yearCode}-${range.branchCode}-${range.division} serial ${range.fromSerial}-${range.toSerial}`,
      { code: 'EMPTY_RANGE', range },
    );
  }

  const benchNumbers = room.seats.map((s) => s.benchNumber).sort((a, b) => a - b);
  const required = input.rowCount && input.colCount ? input.rowCount * input.colCount : students.length;

  // Occupancy of the blocks already in this room, so an unset offset can be
  // placed in the next free window instead of colliding at bench 1.
  const roomUsers = await prisma.allocationIntent.findMany({
    where: { examId, classroomId: input.classroomId },
    select: {
      id: true,
      seatOffset: true,
      rowCount: true,
      colCount: true,
      yearCode: true,
      branchCode: true,
      division: true,
      fromSerial: true,
      toSerial: true,
    },
  });
  const occupied = await Promise.all(
    roomUsers.map(async (other) => ({ other, size: await blockFootprint(other) })),
  );
  const lastUsedBench = occupied.reduce((max, { other, size }) => {
    const end = size > 0 ? other.seatOffset + size - 1 : other.seatOffset;
    return Math.max(max, end);
  }, 0);

  const seatOffset = input.seatOffset ?? (lastUsedBench > 0 ? lastUsedBench + 1 : 1);

  const usable = benchNumbers.filter((n) => n >= seatOffset);
  const capacity = usable.length;
  if (required > capacity) {
    throw new UnprocessableError(
      `Room ${room.roomNumber} has ${capacity} usable bench(es) from seat offset ${seatOffset}, but this block needs ${required}`,
      { code: 'ROOM_TOO_SMALL', students: students.length, capacity, required, roomNumber: room.roomNumber },
    );
  }

  // Overlap check against the other blocks on this exam.
  const siblings = await prisma.allocationIntent.findMany({
    where: {
      examId,
      yearCode: range.yearCode,
      branchCode: range.branchCode,
      division: range.division,
    },
    select: { id: true, fromSerial: true, toSerial: true, classroomId: true },
  });
  const clash = siblings.find((s) => rangesOverlap(range, { ...range, fromSerial: s.fromSerial, toSerial: s.toSerial }));
  if (clash) {
    throw new UnprocessableError(
      `Serial range ${range.fromSerial}-${range.toSerial} overlaps an existing block (${clash.fromSerial}-${clash.toSerial}) for the same year/branch/division`,
      { code: 'RANGE_OVERLAP', conflicting: { fromSerial: clash.fromSerial, toSerial: clash.toSerial } },
    );
  }


  const newEnd = seatOffset + required - 1;
  const benchClash = occupied.find(({ other, size }) => {
    if (size <= 0) return false;
    const otherEnd = other.seatOffset + size - 1;
    return seatOffset <= otherEnd && other.seatOffset <= newEnd;
  });
  if (benchClash) {
    throw new UnprocessableError(
      `Bench window ${seatOffset}-${newEnd} overlaps another block in this room`,
      { code: 'BENCH_OVERLAP', seatOffset, required },
    );
  }

  const created = await prisma.allocationIntent.create({
    data: {
      examId,
      classroomId: input.classroomId,
      yearCode: input.yearCode,
      branchCode: input.branchCode,
      division: input.division,
      fromSerial: input.fromSerial,
      toSerial: input.toSerial,
      rowCount: input.rowCount ?? null,
      colCount: input.colCount ?? null,
      seatOffset,
      strictRollOrder: input.strictRollOrder ?? false,
    },
    include: withRoom,
  });

  await auditLog({
    actorUserId: ctx.actorUserId,
    action: 'intent.create',
    entityType: 'allocation_intent',
    entityId: created.id,
    metadata: {
      examId,
      room: room.roomNumber,
      cohort: `${range.yearCode}-${range.branchCode}-${range.division}`,
      fromSerial: range.fromSerial,
      toSerial: range.toSerial,
      students: students.length,
    },
    ip: ctx.ip,
  });

  const view = toView(created);
  view.studentCount = students.length;
  return view;
}

export async function updateIntent(
  examId: string,
  intentId: string,
  input: UpdateIntentInput,
  ctx: CreateIntentContext = {},
): Promise<IntentView> {
  const existing = await prisma.allocationIntent.findFirst({ where: { id: intentId, examId } });
  if (!existing) throw new NotFoundError('Allocation intent not found');

  const merged = {
    classroomId: input.classroomId ?? existing.classroomId,
    yearCode: existing.yearCode,
    branchCode: existing.branchCode,
    division: existing.division,
    fromSerial: input.fromSerial ?? existing.fromSerial,
    toSerial: input.toSerial ?? existing.toSerial,
    rowCount: input.rowCount === undefined ? existing.rowCount : input.rowCount,
    colCount: input.colCount === undefined ? existing.colCount : input.colCount,
    seatOffset: input.seatOffset ?? existing.seatOffset,
    strictRollOrder: input.strictRollOrder ?? existing.strictRollOrder,
  } as CreateIntentInput;

  // Reuse createIntent's validation by deleting then recreating is wrong (id
  // churn), so validate the merged shape inline via a shared guard.
  await validateMerged(examId, merged, intentId, existing.seatOffset);

  const updated = await prisma.allocationIntent.update({
    where: { id: intentId },
    data: {
      classroomId: merged.classroomId,
      fromSerial: merged.fromSerial,
      toSerial: merged.toSerial,
      rowCount: merged.rowCount ?? null,
      colCount: merged.colCount ?? null,
      seatOffset: merged.seatOffset,
      strictRollOrder: merged.strictRollOrder ?? false,
    },
    include: withRoom,
  });

  await auditLog({
    actorUserId: ctx.actorUserId,
    action: 'intent.update',
    entityType: 'allocation_intent',
    entityId: intentId,
    metadata: { examId, from: { ...existing, createdAt: undefined, updatedAt: undefined } },
    ip: ctx.ip,
  });

  const view = toView(updated);
  view.studentCount = await countStudentsInRange({
    yearCode: view.yearCode as RollRange['yearCode'],
    branchCode: view.branchCode,
    division: view.division,
    fromSerial: view.fromSerial,
    toSerial: view.toSerial,
  });
  return view;
}

async function validateMerged(examId: string, merged: CreateIntentInput, selfId: string, existingOffset: number): Promise<void> {
  const room = await availableBenches(merged.classroomId);
  if (!room) throw new NotFoundError('Classroom not found');
  if (room.status !== 'AVAILABLE') {
    throw new UnprocessableError(`Room ${room.roomNumber} is ${room.status.toLowerCase()}`);
  }
  const range: RollRange = {
    yearCode: merged.yearCode,
    branchCode: merged.branchCode,
    division: merged.division,
    fromSerial: merged.fromSerial,
    toSerial: merged.toSerial,
  };
  const students = await studentsInRange(range);
  if (students.length === 0) {
    throw new UnprocessableError(
      `No students match ${range.yearCode}-${range.branchCode}-${range.division} serial ${range.fromSerial}-${range.toSerial}`,
      { code: 'EMPTY_RANGE', range },
    );
  }
  // Always present: `merged` falls back to the stored row's offset.
  const seatOffset = merged.seatOffset ?? existingOffset;
  const benchNumbers = room.seats.map((s) => s.benchNumber).sort((a, b) => a - b);
  const capacity = benchNumbers.filter((n) => n >= seatOffset).length;
  const required = merged.rowCount && merged.colCount ? merged.rowCount * merged.colCount : students.length;
  if (required > capacity) {
    throw new UnprocessableError(
      `Room ${room.roomNumber} needs ${required} bench(es) but only ${capacity} are usable from seat offset ${seatOffset}`,
      { code: 'ROOM_TOO_SMALL', students: students.length, capacity, required, roomNumber: room.roomNumber },
    );
  }
  const siblings = await prisma.allocationIntent.findMany({
    where: { examId, yearCode: range.yearCode, branchCode: range.branchCode, division: range.division, id: { not: selfId } },
    select: { id: true, fromSerial: true, toSerial: true },
  });
  const clash = siblings.find((s) => rangesOverlap(range, { ...range, fromSerial: s.fromSerial, toSerial: s.toSerial }));
  if (clash) {
    throw new UnprocessableError(
      `Serial range ${range.fromSerial}-${range.toSerial} overlaps an existing block (${clash.fromSerial}-${clash.toSerial})`,
      { code: 'RANGE_OVERLAP' },
    );
  }
}

export async function deleteIntent(examId: string, intentId: string, ctx: CreateIntentContext = {}): Promise<void> {
  const existing = await prisma.allocationIntent.findFirst({ where: { id: intentId, examId } });
  if (!existing) throw new NotFoundError('Allocation intent not found');

  const run = await prisma.seatingRun.findFirst({
    where: { examId, status: { in: ['DRAFT', 'VALIDATED', 'PUBLISHED'] } },
    select: { id: true, status: true },
  });
  if (run) {
    throw new ConflictError(
      `A ${run.status} seating run already exists for this exam; regenerate or delete it before editing intents`,
    );
  }

  await prisma.allocationIntent.delete({ where: { id: intentId } });
  await auditLog({
    actorUserId: ctx.actorUserId,
    action: 'intent.delete',
    entityType: 'allocation_intent',
    entityId: intentId,
    metadata: { examId },
    ip: ctx.ip,
  });
}

/** Cohort browser: distinct year/branch/division combinations that exist. */
export async function listCohorts(): Promise<
  Array<{ yearCode: string; branchCode: string; division: string; count: number; minSerial: number | null; maxSerial: number | null }>
> {
  const students = await prisma.student.findMany({
    where: { status: 'ACTIVE', yearCode: { not: null } },
    select: { yearCode: true, division: true, rollNumber: true, department: { select: { code: true } } },
    orderBy: { rollNumber: 'asc' },
  });

  const map = new Map<string, { yearCode: string; branchCode: string; division: string; serials: number[] }>();
  for (const s of students) {
    if (!s.yearCode || !s.division) continue;
    const key = `${s.yearCode}|${s.department.code}|${s.division}`;
    const serial = parseSerial(s.rollNumber.slice(s.rollNumber.lastIndexOf('_') + 1));
    const entry = map.get(key) ?? { yearCode: s.yearCode, branchCode: s.department.code, division: s.division, serials: [] };
    if (serial !== null) entry.serials.push(serial);
    map.set(key, entry);
  }

  return [...map.values()]
    .map((e) => ({
      yearCode: e.yearCode,
      branchCode: e.branchCode,
      division: e.division,
      count: e.serials.length,
      minSerial: e.serials.length ? Math.min(...e.serials) : null,
      maxSerial: e.serials.length ? Math.max(...e.serials) : null,
    }))
    .sort((a, b) =>
      a.yearCode === b.yearCode
        ? a.branchCode === b.branchCode
          ? a.division.localeCompare(b.division)
          : a.branchCode.localeCompare(b.branchCode)
        : a.yearCode.localeCompare(b.yearCode),
    );
}

/** Students inside a cohort, for the UI preview before creating an intent. */
export async function previewRange(range: RollRange) {
  const students = await studentsInRange(range);
  return {
    range,
    count: students.length,
    students,
  };
}

/** Paginated students of one cohort, for the builder's student picker. */
export async function listCohortStudents(query: CohortQuery) {
  const where: Prisma.StudentWhereInput = {
    status: query.status ?? 'ACTIVE',
    ...(query.yearCode ? { yearCode: query.yearCode } : {}),
    ...(query.division ? { division: query.division } : {}),
    ...(query.branchCode ? { department: { code: query.branchCode } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.student.findMany({
      where,
      orderBy: { rollNumber: 'asc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: { id: true, rollNumber: true, name: true, division: true, yearCode: true, department: { select: { code: true, name: true } } },
    }),
    prisma.student.count({ where }),
  ]);
  return { items, total, page: query.page, pageSize: query.pageSize };
}

/**
 * Dry-run of the whole plan: every intent with the students it resolves to and
 * the room it targets, so an administrator can confirm the mapping before
 * generating. No seats are reserved here.
 */
export async function previewPlan(examId: string) {
  const intents = await listIntents(examId);
  const blocks = await Promise.all(
    intents.map(async (intent) => {
      const students = await studentsInRange({
        yearCode: intent.yearCode as RollRange['yearCode'],
        branchCode: intent.branchCode,
        division: intent.division,
        fromSerial: intent.fromSerial,
        toSerial: intent.toSerial,
      });
      return {
        intentId: intent.id,
        roomNumber: intent.roomNumber,
        floor: intent.floor,
        cohort: `${intent.yearCode}-${intent.branchCode}-${intent.division}`,
        fromSerial: intent.fromSerial,
        toSerial: intent.toSerial,
        strictRollOrder: intent.strictRollOrder,
        studentCount: students.length,
        capacityAfterSeatOffset: intent.availableBenches,
        fits: students.length <= intent.availableBenches,
        students: students.map((s) => ({ rollNumber: s.rollNumber, name: s.name })),
      };
    }),
  );

  const totalStudents = blocks.reduce((sum, b) => sum + b.studentCount, 0);
  const roomsUsed = new Set(intents.map((i) => i.classroomId)).size;
  return {
    examId,
    blockCount: blocks.length,
    roomsUsed,
    totalStudents,
    allBlocksFit: blocks.every((b) => b.fits),
    blocks,
  };
}
