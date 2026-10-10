import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import {
  NotFoundError,
  ConflictError,
  ForbiddenError,
  ValidationError,
  InternalError,
  UnprocessableError,
  AppError,
} from '../../common/errors.js';
import { auditLog } from '../audit/audit.service.js';
import { runInWorker } from '../../engine/worker.js';
import { validate } from '../../engine/validate.js';
import type {
  Assignment,
  EngineConfig,
  EngineInput,
  EngineResult,
  FailureCode,
  HistoryExam,
  PrevAssignment,
  Room,
  Student,
} from '../../engine/types.js';
import { withTransaction } from '../../db/tx.js';

type Tx = Prisma.TransactionClient;

export type GenerateOptions = {
  mode?: 'MIXED' | 'BLOCK';
  seed?: string | number;
  roomIds?: string[];
  historyDepth?: number;
  timeBudgetMs?: number;
};

export type RegenerateOptions = GenerateOptions & {
  reason?: string;
  confirm?: boolean;
};

const PLAN_RUN_STATUSES = ['DRAFT', 'VALIDATED', 'PUBLISHED'] as const;
const ACTIVE_RUN_STATUSES = ['DRAFT', 'VALIDATED'] as const;

/** Deep-clones into a value Prisma accepts for Json columns (drops undefined). */
function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

const DEFAULT_WEIGHTS = {
  sameSeat: 100,
  sameRoom: 30,
  sameBenchNo: 10,
  sameLeftNeighbour: 20,
  sameRightNeighbour: 20,
  sameDeptAdjacent: 15,
  imbalance: 1,
  sequentialRoll: 5,
};

function baseConfig(options: GenerateOptions, seed: string): EngineConfig {
  return {
    mode: options.mode ?? 'MIXED',
    seed,
    timeBudgetMs: options.timeBudgetMs ?? env.SEATING_TIME_BUDGET_MS,
    historyDepth: options.historyDepth ?? env.SEATING_DEFAULT_HISTORY_DEPTH,
    weights: DEFAULT_WEIGHTS,
    kCandidates: 16,
  };
}

function toMinutes(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function timesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return toMinutes(aStart) < toMinutes(bEnd) && toMinutes(bStart) < toMinutes(aEnd);
}

/** Rooms already allocated by a clashing exam that has a usable seating plan. */
async function loadBlockedRoomIds(
  tx: Tx,
  exam: { id: string; examDate: Date; startTime: Date; endTime: Date },
): Promise<Set<string>> {
  const sameDay = await tx.exam.findMany({
    where: { id: { not: exam.id }, status: { not: 'CANCELLED' }, examDate: exam.examDate },
    select: { id: true, startTime: true, endTime: true },
  });
  const clashIds = sameDay
    .filter((o) => timesOverlap(exam.startTime, exam.endTime, o.startTime, o.endTime))
    .map((o) => o.id);
  if (clashIds.length === 0) return new Set();
  const runs = await tx.seatingRun.findMany({
    where: { examId: { in: clashIds }, status: { in: [...PLAN_RUN_STATUSES] } },
    select: { examId: true },
  });
  if (runs.length === 0) return new Set();
  const allocs = await tx.seatingAllocation.findMany({
    where: { examId: { in: runs.map((r) => r.examId) } },
    select: { classroomId: true },
  });
  return new Set(allocs.map((a) => a.classroomId));
}

/** Previous-paper seating history for these students (newest first, depth-limited). */
async function loadHistory(
  tx: Tx,
  exam: { id: string; academicYearId: string; examDate: Date },
  depth: number,
): Promise<HistoryExam[]> {
  if (depth <= 0) return [];
  const runs = await tx.seatingRun.findMany({
    where: {
      examId: { not: exam.id },
      status: { in: [...PLAN_RUN_STATUSES] },
      exam: { academicYearId: exam.academicYearId },
      generatedAt: { lt: exam.examDate },
    },
    orderBy: { generatedAt: 'desc' },
    take: depth,
    include: { allocations: { include: { seat: { select: { benchNumber: true } } } } },
  });
  return runs.map((r, i) => {
    // Neighbours are the students on the immediately adjacent benches of the
    // same room (bench order), not bench-mates — a seat has only one student.
    const byRoom = new Map<
      string,
      Array<{ studentId: string; roomId: string; seatId: string; benchNo: number }>
    >();
    for (const a of r.allocations) {
      const list = byRoom.get(a.classroomId) ?? [];
      list.push({ studentId: a.studentId, roomId: a.classroomId, seatId: a.seatId, benchNo: a.seat.benchNumber });
      byRoom.set(a.classroomId, list);
    }
    const assignments: PrevAssignment[] = [];
    for (const list of byRoom.values()) {
      list.sort((x, y) => x.benchNo - y.benchNo);
      list.forEach((cur, idx) => {
        const left = list[idx - 1];
        const right = list[idx + 1];
        assignments.push({
          studentId: cur.studentId,
          roomId: cur.roomId,
          seatId: cur.seatId,
          benchNo: cur.benchNo,
          leftNeighbourId: left ? left.studentId : null,
          rightNeighbourId: right ? right.studentId : null,
        });
      });
    }
    return { examId: r.examId, order: runs.length - i, assignments };
  });
}

async function loadExam(examId: string) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw new NotFoundError('Exam not found');
  return exam;
}

type StructureFailure = { code: FailureCode; message: string; details?: Record<string, unknown> };

function failureMessage(f: StructureFailure): string {
  if (f.code === 'INSUFFICIENT_SEATS' && typeof f.details?.additionalRequired === 'number') {
    return `${f.message} Additional seats required: ${f.details.additionalRequired}.`;
  }
  return f.message;
}

export async function generateSeatingForExam(
  examId: string,
  userId: string,
  options: GenerateOptions = {},
  ip: string | null = null,
): Promise<{ run: unknown }> {
  let outcome:
    | { kind: 'failure'; failure: StructureFailure; runId: string }
    | { kind: 'success'; runId: string; stats: unknown; penalty: number; timing: unknown; report: unknown };

  try {
    outcome = await withTransaction(async (tx) => {
      const lockRows = (await tx.$queryRaw`
        SELECT pg_try_advisory_xact_lock(hashtext(${examId})::bigint) AS locked
      `) as Array<{ locked: boolean }>;
      if (!lockRows[0]?.locked) {
        throw new ConflictError('A seating generation for this exam is already in progress. Try again shortly.');
      }

      const exam = await tx.exam.findUnique({ where: { id: examId } });
      if (!exam) throw new NotFoundError('Exam not found');
      if (exam.seatingStatus === 'PUBLISHED') {
        throw new ConflictError('Seating plan is PUBLISHED. Unpublish it (Super Admin) or use regenerate with a reason first.');
      }

      const registrations = await tx.examRegistration.findMany({
        where: { examId, status: 'REGISTERED', student: { status: 'ACTIVE' } },
        include: { student: true },
        orderBy: { studentId: 'asc' },
      });

      const seed = String(options.seed ?? Date.now());

      if (registrations.length === 0) {
        const failed = await tx.seatingRun.create({
          data: {
            examId,
            seed,
            status: 'FAILED',
            algorithmVersion: 'v1',
            config: asJson(options),
            failure: asJson({
              code: 'NO_ELIGIBLE_STUDENTS',
              message: 'No active registered students eligible for this exam.',
            }),
            generatedBy: userId,
          },
        });
        return {
          kind: 'failure' as const,
          failure: { code: 'NO_ELIGIBLE_STUDENTS', message: 'No active registered students eligible for this exam.' },
          runId: failed.id,
        };
      }

      const blockedRoomIds = await loadBlockedRoomIds(tx, exam);
      const idFilter: { in?: string[]; notIn?: string[] } = {};
      if (options.roomIds && options.roomIds.length > 0) idFilter.in = options.roomIds;
      if (blockedRoomIds.size > 0) idFilter.notIn = [...blockedRoomIds];
      const rooms = await tx.classroom.findMany({
        where: {
          status: 'AVAILABLE',
          ...(Object.keys(idFilter).length > 0 ? { id: idFilter } : {}),
        },
        include: { seats: { where: { status: 'AVAILABLE' }, orderBy: { benchNumber: 'asc' } } },
        orderBy: { id: 'asc' },
      });

      const engineRooms: Room[] = rooms
        .filter((r) => r.seats.length > 0)
        .map((r) => ({
          id: r.id,
          building: r.building,
          roomNumber: r.roomNumber,
          seats: r.seats.map((s) => ({ id: s.id, benchNo: s.benchNumber, row: s.rowNo, col: s.colNo })),
        }));

      const students: Student[] = registrations.map((r) => ({
        id: r.studentId,
        rollNo: r.student.rollNumber,
        departmentId: r.student.departmentId,
        divisionId: r.student.division,
      }));

      const historyDepth = options.historyDepth ?? env.SEATING_DEFAULT_HISTORY_DEPTH;
      const history = await loadHistory(tx, exam, historyDepth);

      const config = baseConfig(options, seed);
      const input: EngineInput = { students, rooms: engineRooms, history, config };
      const gen: EngineResult = await runInWorker(input);

      if (!gen.ok) {
        const failed = await tx.seatingRun.create({
          data: {
            examId,
            seed,
            status: 'FAILED',
            algorithmVersion: 'v1',
            config: asJson(options),
            failure: asJson(gen.failure),
            generatedBy: userId,
          },
        });
        return { kind: 'failure' as const, failure: gen.failure as StructureFailure, runId: failed.id };
      }

      const previous = await tx.seatingRun.findMany({
        where: { examId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      });
      for (const p of previous) {
        await tx.seatingRun.update({ where: { id: p.id }, data: { status: 'SUPERSEDED' } });
      }

      const runId = randomUUID();
      await tx.seatingRun.create({
        data: {
          id: runId,
          examId,
          seed,
          status: 'VALIDATED',
          algorithmVersion: 'v1',
          config: asJson(options),
          totalPenalty: gen.penalty,
          stats: asJson(gen.stats),
          generatedBy: userId,
        },
      });

      const deptByStudent = new Map<string, string>();
      for (const s of students) deptByStudent.set(s.id, s.departmentId);
      await tx.seatingAllocation.createMany({
        data: gen.assignments.map((a) => ({
          id: randomUUID(),
          runId,
          examId,
          studentId: a.studentId,
          classroomId: a.roomId,
          seatId: a.seatId,
          academicYearId: exam.academicYearId,
          departmentId: deptByStudent.get(a.studentId)!,
        })),
      });

      const stored = await tx.seatingAllocation.findMany({
        where: { runId },
        include: { seat: { select: { benchNumber: true } } },
      });
      const readBack: Assignment[] = stored.map((a) => ({
        studentId: a.studentId,
        roomId: a.classroomId,
        seatId: a.seatId,
        benchNo: a.seat.benchNumber,
      }));
      const report = validate(input, readBack);
      if (report.status === 'INVALID') {
        throw new InternalError('Post-save validation of the seating plan failed; the plan was rolled back.', {
          report,
        });
      }
      await tx.seatingRun.update({ where: { id: runId }, data: { validationReport: asJson(report) } });

      await tx.exam.update({ where: { id: examId }, data: { seatingStatus: 'VALIDATED', isStale: false } });

      return {
        kind: 'success' as const,
        runId,
        stats: gen.stats,
        penalty: gen.penalty,
        timing: gen.timing,
        report,
      };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    await auditLog({
      actorUserId: userId,
      action: 'seating.generate_failed',
      entityType: 'exam',
      entityId: examId,
      metadata: { error: String(err) },
      ip,
    });
    throw err;
  }

  if (outcome.kind === 'failure') {
    await auditLog({
      actorUserId: userId,
      action: 'seating.generate_failed',
      entityType: 'exam',
      entityId: examId,
      metadata: asJson({ runId: outcome.runId, failure: outcome.failure }),
      ip,
    });
    throw new UnprocessableError(failureMessage(outcome.failure), {
      runId: outcome.runId,
      failure: outcome.failure,
    });
  }

  const saved = await prisma.seatingRun.findUnique({ where: { id: outcome.runId } });

  await auditLog({
    actorUserId: userId,
    action: 'seating.generate',
    entityType: 'exam',
    entityId: examId,
    metadata: asJson({
      runId: outcome.runId,
      seed: saved?.seed ?? null,
      penalty: outcome.penalty,
      students: (outcome.report as { students?: number }).students,
    }),
    ip,
  });

  return {
    run: {
      ...saved,
      stats: outcome.stats,
      penalty: outcome.penalty,
      timing: outcome.timing,
      validationReport: outcome.report,
    },
  };
}

async function unpublishInternal(examId: string, userId: string, reason: string, ip: string | null) {
  const run = await prisma.seatingRun.findFirst({ where: { examId, status: 'PUBLISHED' } });
  if (!run) throw new NotFoundError('No published seating run found for this exam.');
  await withTransaction(async (tx) => {
    await tx.$executeRaw`SELECT allow_published_mutation()`;
    await tx.seatingAllocation.updateMany({ where: { runId: run.id }, data: { publishedAt: null } });
    await tx.seatingRun.update({
      where: { id: run.id },
      data: { status: 'VALIDATED', publishedBy: null, publishedAt: null },
    });
    await tx.exam.update({ where: { id: examId }, data: { seatingStatus: 'VALIDATED' } });
  });
  await auditLog({
    actorUserId: userId,
    action: 'seating.unpublish',
    entityType: 'exam',
    entityId: examId,
    metadata: { runId: run.id, reason },
    ip,
  });
  return run;
}

export async function regenerateSeatingForExam(
  examId: string,
  userId: string,
  options: RegenerateOptions = {},
  role: string,
  ip: string | null = null,
): Promise<{ run: unknown }> {
  const exam = await loadExam(examId);
  if (exam.seatingStatus === 'PUBLISHED') {
    if (role !== 'SUPER_ADMIN') {
      throw new ForbiddenError('Regenerating a PUBLISHED seating plan requires the SUPER_ADMIN role.');
    }
    if (!options.reason || options.confirm !== true) {
      throw new ValidationError('Regenerating a PUBLISHED plan requires a reason and confirm: true.');
    }
    await unpublishInternal(examId, userId, `regenerate: ${options.reason}`, ip);
  }
  const { reason: _reason, confirm: _confirm, ...generateOptions } = options;
  const result = await generateSeatingForExam(examId, userId, generateOptions, ip);
  await auditLog({
    actorUserId: userId,
    action: 'seating.regenerate',
    entityType: 'exam',
    entityId: examId,
    metadata: { reason: options.reason ?? null },
    ip,
  });
  return result;
}

type StaleReport = {
  runId: string;
  runStatus: string;
  status: 'VALID' | 'STALE';
  eligibleCount: number;
  seatedCount: number;
  addedAfterGeneration: Array<{ studentId: string; rollNumber: string; name: string }>;
  removedButSeated: Array<{ studentId: string; rollNumber: string; name: string }>;
  disabledRooms: Array<{ classroomId: string; roomNumber: string; status: string }>;
  disabledSeats: Array<{ seatId: string; classroomId: string }>;
};

async function computeStaleReport(
  examId: string,
  run: {
    id: string;
    status: string;
    allocations: Array<{
      studentId: string;
      student: { rollNumber: string; name: string };
      classroom: { id: string; roomNumber: string; status: string };
      seat: { id: string; status: string };
    }>;
  },
): Promise<StaleReport> {
  const eligible = await prisma.examRegistration.findMany({
    where: { examId, status: 'REGISTERED', student: { status: 'ACTIVE' } },
    select: { studentId: true, student: { select: { rollNumber: true, name: true } } },
    orderBy: { studentId: 'asc' },
  });
  const eligibleIds = new Set(eligible.map((e) => e.studentId));
  const seatedIds = new Set(run.allocations.map((a) => a.studentId));

  const addedAfterGeneration = eligible
    .filter((e) => !seatedIds.has(e.studentId))
    .map((e) => ({ studentId: e.studentId, rollNumber: e.student.rollNumber, name: e.student.name }));
  const removedButSeated = run.allocations
    .filter((a) => !eligibleIds.has(a.studentId))
    .map((a) => ({ studentId: a.studentId, rollNumber: a.student.rollNumber, name: a.student.name }));

  const seenRooms = new Map<string, { classroomId: string; roomNumber: string; status: string }>();
  const disabledSeats: Array<{ seatId: string; classroomId: string }> = [];
  for (const a of run.allocations) {
    if (a.classroom.status !== 'AVAILABLE' && !seenRooms.has(a.classroom.id)) {
      seenRooms.set(a.classroom.id, {
        classroomId: a.classroom.id,
        roomNumber: a.classroom.roomNumber,
        status: a.classroom.status,
      });
    }
    if (a.seat.status !== 'AVAILABLE') {
      disabledSeats.push({ seatId: a.seat.id, classroomId: a.classroom.id });
    }
  }

  const hasIssues =
    addedAfterGeneration.length > 0 ||
    removedButSeated.length > 0 ||
    seenRooms.size > 0 ||
    disabledSeats.length > 0;

  return {
    runId: run.id,
    runStatus: run.status,
    status: hasIssues ? 'STALE' : 'VALID',
    eligibleCount: eligible.length,
    seatedCount: run.allocations.length,
    addedAfterGeneration,
    removedButSeated,
    disabledRooms: [...seenRooms.values()],
    disabledSeats,
  };
}

const RUN_INCLUDE = {
  allocations: {
    include: {
      student: { select: { rollNumber: true, name: true } },
      classroom: { select: { id: true, roomNumber: true, status: true } },
      seat: { select: { id: true, status: true, benchNumber: true, rowNo: true, colNo: true } },
      department: { select: { id: true, code: true, name: true } },
    },
  },
} as const;

async function loadActiveRun(examId: string) {
  const run = await prisma.seatingRun.findFirst({
    where: { examId, status: { in: [...PLAN_RUN_STATUSES] } },
    orderBy: { generatedAt: 'desc' },
    include: RUN_INCLUDE,
  });
  if (!run) throw new NotFoundError('No seating plan exists for this exam.');
  return run;
}

export async function getSeating(examId: string): Promise<unknown> {
  await loadExam(examId);
  const run = await loadActiveRun(examId);
  return presentSeating(run);
}

function presentSeating(run: Awaited<ReturnType<typeof loadActiveRun>>) {
  return {
    run: {
      id: run.id,
      status: run.status,
      seed: run.seed,
      stats: run.stats,
      validationReport: run.validationReport,
      totalPenalty: run.totalPenalty,
      generatedAt: run.generatedAt,
      publishedAt: run.publishedAt,
      algorithmVersion: run.algorithmVersion,
    },
    allocations: run.allocations.map((a) => ({
      studentId: a.studentId,
      rollNumber: a.student.rollNumber,
      name: a.student.name,
      classroomId: a.classroomId,
      roomNumber: a.classroom.roomNumber,
      seatId: a.seatId,
      benchNo: a.seat.benchNumber,
      row: a.seat.rowNo,
      col: a.seat.colNo,
      seatStatus: a.seat.status,
      departmentId: a.departmentId,
      departmentCode: a.department.code,
      departmentName: a.department.name,
      publishedAt: a.publishedAt,
    })),
  };
}

export async function getSeatingValidation(examId: string): Promise<unknown> {
  await loadExam(examId);
  const run = await loadActiveRun(examId);
  const report = await computeStaleReport(examId, run);
  return {
    ...report,
    suggestion: report.status === 'STALE' ? 'Regenerate the seating plan before publishing.' : null,
  };
}

export async function listRuns(examId: string): Promise<unknown> {
  await loadExam(examId);
  const runs = await prisma.seatingRun.findMany({
    where: { examId },
    orderBy: { generatedAt: 'desc' },
    include: { _count: { select: { allocations: true } } },
  });
  return {
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      seed: r.seed,
      totalPenalty: r.totalPenalty,
      stats: r.stats,
      failure: r.failure,
      validationReport: r.validationReport,
      allocationCount: r._count.allocations,
      generatedAt: r.generatedAt,
      generatedBy: r.generatedBy,
      publishedAt: r.publishedAt,
      algorithmVersion: r.algorithmVersion,
    })),
  };
}

export async function publishSeating(examId: string, userId: string, ip: string | null = null): Promise<unknown> {
  const exam = await loadExam(examId);
  if (exam.seatingStatus === 'PUBLISHED') throw new ConflictError('Seating plan is already PUBLISHED.');

  const run = await prisma.seatingRun.findFirst({
    where: { examId, status: 'VALIDATED' },
    orderBy: { generatedAt: 'desc' },
    include: RUN_INCLUDE,
  });
  if (!run) {
    throw new ConflictError('No VALIDATED seating run to publish. Generate and validate a plan first.');
  }

  const stale = await computeStaleReport(examId, run);
  if (exam.isStale || stale.status === 'STALE') {
    throw new ConflictError(
      'Seating plan is stale — registrations, schedule or room data changed since generation. Regenerate the seating plan before publishing.',
      { stale, scheduleChanged: exam.isStale },
    );
  }

  const eligible = await prisma.examRegistration.findMany({
    where: { examId, status: 'REGISTERED', student: { status: 'ACTIVE' } },
    select: { studentId: true, student: { select: { departmentId: true, rollNumber: true } } },
    orderBy: { studentId: 'asc' },
  });
  // Rebuild the real engine input (rooms with every seat, current eligibility)
  // so the independent validator re-checks the stored plan against live data.
  const roomIds = [...new Set(run.allocations.map((a) => a.classroomId))];
  const classrooms = await prisma.classroom.findMany({
    where: { id: { in: roomIds } },
    include: { seats: { orderBy: { benchNumber: 'asc' } } },
  });
  const engineRooms: Room[] = classrooms.map((c) => ({
    id: c.id,
    building: c.building,
    roomNumber: c.roomNumber,
    seats: c.seats.map((s) => ({
      id: s.id,
      benchNo: s.benchNumber,
      row: s.rowNo,
      col: s.colNo,
      status: s.status as 'AVAILABLE' | 'DISABLED',
    })),
  }));
  const input: EngineInput = {
    students: eligible.map((e) => ({
      id: e.studentId,
      rollNo: e.student.rollNumber,
      departmentId: e.student.departmentId,
    })),
    rooms: engineRooms,
    history: [],
    config: baseConfig({}, run.seed),
  };
  const readBack: Assignment[] = run.allocations.map((a) => ({
    studentId: a.studentId,
    roomId: a.classroomId,
    seatId: a.seatId,
    benchNo: a.seat.benchNumber,
  }));
  const report = validate(input, readBack);
  if (report.status === 'INVALID') {
    throw new ConflictError('Stored seating plan failed re-validation and cannot be published.', { report });
  }

  const now = new Date();
  await withTransaction(async (tx) => {
    await tx.seatingAllocation.updateMany({ where: { runId: run.id }, data: { publishedAt: now } });
    await tx.seatingRun.update({
      where: { id: run.id },
      data: { status: 'PUBLISHED', publishedBy: userId, publishedAt: now, validationReport: asJson(report) },
    });
    await tx.exam.update({ where: { id: examId }, data: { seatingStatus: 'PUBLISHED' } });
  });

  await auditLog({
    actorUserId: userId,
    action: 'seating.publish',
    entityType: 'exam',
    entityId: examId,
    metadata: { runId: run.id },
    ip,
  });
  return { published: true, runId: run.id, publishedAt: now };
}

export async function unpublishSeating(
  examId: string,
  userId: string,
  reason: string,
  ip: string | null = null,
): Promise<unknown> {
  const exam = await loadExam(examId);
  if (exam.seatingStatus !== 'PUBLISHED') throw new ConflictError('Seating plan is not PUBLISHED.');
  if (!reason || reason.length < 5) {
    throw new ValidationError('A reason (min 5 characters) is required to unpublish.');
  }
  const run = await unpublishInternal(examId, userId, reason, ip);
  return { unpublished: true, runId: run.id, reason };
}

export async function studentSeatingHistory(studentId: string): Promise<unknown> {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: { id: true, rollNumber: true, name: true },
  });
  if (!student) throw new NotFoundError('Student not found');
  const allocations = await prisma.seatingAllocation.findMany({
    where: { studentId },
    include: {
      exam: { select: { id: true, subject: true, examDate: true, startTime: true, endTime: true } },
      run: { select: { id: true, status: true, seed: true } },
      classroom: { select: { id: true, roomNumber: true, building: true } },
      seat: { select: { benchNumber: true, rowNo: true, colNo: true } },
    },
    orderBy: { generatedAt: 'desc' },
  });
  return {
    studentId,
    rollNumber: student.rollNumber,
    name: student.name,
    history: allocations.map((a) => ({
      examId: a.exam.id,
      subject: a.exam.subject,
      examDate: a.exam.examDate,
      startTime: a.exam.startTime,
      endTime: a.exam.endTime,
      runId: a.runId,
      runStatus: a.run.status,
      classroomId: a.classroomId,
      roomNumber: a.classroom.roomNumber,
      building: a.classroom.building,
      seatId: a.seatId,
      benchNo: a.seat.benchNumber,
      generatedAt: a.generatedAt,
      publishedAt: a.publishedAt,
    })),
  };
}
