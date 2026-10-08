import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { ConflictError, InternalError, NotFoundError, UnprocessableError } from '../../common/errors.js';
import { auditLog } from '../audit/audit.service.js';
import { generateSeating } from '../../engine/index.js';
import { validate } from '../../engine/validate.js';
import type { Assignment, EngineInput, EngineResult, HistoryExam, Room, Student } from '../../engine/types.js';
import { studentsInRange } from './intents.service.js';
import type { RollRange } from './roll.js';

/** Penalty weights, mirroring the exam-wide generator's defaults. */
const DEFAULT_WEIGHTS = {
  sameSeat: 100,
  sameRoom: 30,
  sameBenchNo: 10,
  sameLeftNeighbour: 20,
  sameRightNeighbour: 20,
  sameDeptAdjacent: 15,
  imbalance: 1,
  sequentialRoll: 5,
} as const;

/** Statuses that count as "the exam already has a plan". */
const ACTIVE_RUN_STATUSES = ['DRAFT', 'VALIDATED', 'PUBLISHED'] as const;

export interface GenerateFromIntentsOptions {
  seed?: string;
  historyDepth?: number;
  timeBudgetMs?: number;
  /** Replaces the current plan instead of failing when one exists. */
  replace?: boolean;
}

export interface BlockResult {
  intentId: string;
  roomNumber: string | null;
  floor: string | null;
  cohort: string;
  students: number;
  penalty: number;
  strictRollOrder: boolean;
}

export interface GenerateFromIntentsResult {
  runId: string;
  totalSeated: number;
  totalPenalty: number;
  roomsUsed: number;
  blocks: BlockResult[];
  timing: { totalMs: number };
  validation: { status: string; violations: number };
}

/**
 * Previous-paper seating for these students, newest first.
 *
 * Deliberately the same rule as the exam-wide generator: every usable run in
 * the academic year before this exam's date, so a student seated in any
 * earlier paper is a repeat candidate regardless of subject.
 */
async function loadHistory(
  tx: Prisma.TransactionClient | typeof prisma,
  exam: { id: string; academicYearId: string; examDate: Date },
  depth: number,
  studentIds: Set<string>,
): Promise<HistoryExam[]> {
  if (depth <= 0 || studentIds.size === 0) return [];
  const runs = await tx.seatingRun.findMany({
    where: {
      examId: { not: exam.id },
      status: { in: ['DRAFT', 'VALIDATED', 'PUBLISHED'] },
      exam: { academicYearId: exam.academicYearId },
      generatedAt: { lt: exam.examDate },
    },
    orderBy: { generatedAt: 'desc' },
    take: depth,
    include: {
      allocations: {
        where: { studentId: { in: [...studentIds] } },
        include: { seat: { select: { benchNumber: true } } },
      },
    },
  });

  return runs.map((run, i) => {
    const byRoom = new Map<
      string,
      Array<{ studentId: string; roomId: string; seatId: string; benchNo: number }>
    >();
    for (const a of run.allocations) {
      const list = byRoom.get(a.classroomId) ?? [];
      list.push({ studentId: a.studentId, roomId: a.classroomId, seatId: a.seatId, benchNo: a.seat.benchNumber });
      byRoom.set(a.classroomId, list);
    }
    const assignments: HistoryExam['assignments'] = [];
    for (const list of byRoom.values()) {
      list.sort((x, y) => x.benchNo - y.benchNo);
      list.forEach((cur, idx) => {
        assignments.push({
          studentId: cur.studentId,
          roomId: cur.roomId,
          seatId: cur.seatId,
          benchNo: cur.benchNo,
          leftNeighbourId: list[idx - 1]?.studentId ?? null,
          rightNeighbourId: list[idx + 1]?.studentId ?? null,
        });
      });
    }
    return { examId: run.examId, order: runs.length - i, assignments };
  });
}

/**
 * Generates a plan by executing the administrator's intents.
 *
 * Each intent is an independent sub-plan: its own students (the roll range),
 * its own room and bench window, and its own history, so the "don't repeat the
 * last allocation" penalties apply within the block the administrator defined.
 * The merged result is then validated as a whole and saved in one transaction.
 */
export async function generateFromIntents(
  examId: string,
  options: GenerateFromIntentsOptions = {},
  ctx: { actorUserId?: string | null; ip?: string | null } = {},
): Promise<GenerateFromIntentsResult> {
  const t0 = Date.now();

  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    select: { id: true, subject: true, examDate: true, academicYearId: true, seatingStatus: true },
  });
  if (!exam) throw new NotFoundError('Exam not found');
  if (exam.seatingStatus === 'PUBLISHED') {
    throw new ConflictError('Cannot regenerate while the plan is published; unpublish first.');
  }

  const intents = await prisma.allocationIntent.findMany({
    where: { examId },
    include: { classroom: { include: { seats: { where: { status: 'AVAILABLE' } } } } },
    orderBy: [{ classroomId: 'asc' }, { seatOffset: 'asc' }],
  });
  if (intents.length === 0) {
    throw new UnprocessableError(
      'This exam has no allocation intents yet. Add at least one roll-number range mapped to a room first.',
      { code: 'NO_INTENTS' },
    );
  }

  const existingRun = await prisma.seatingRun.findFirst({
    where: { examId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true, status: true },
  });
  if (existingRun && !options.replace) {
    throw new ConflictError(
      `A ${existingRun.status} plan already exists for this exam. Pass replace=true to regenerate.`,
      { code: 'PLAN_EXISTS', runId: existingRun.id, status: existingRun.status },
    );
  }

  const seed = options.seed?.trim() || `dypit-${examId.slice(0, 8)}`;
  const historyDepth = options.historyDepth ?? env.SEATING_DEFAULT_HISTORY_DEPTH;
  const timeBudgetMs = options.timeBudgetMs ?? env.SEATING_TIME_BUDGET_MS;

  // Resolve every block's students up front so history can be loaded once for
  // the whole set rather than per block.
  const resolved = [];
  for (const intent of intents) {
    const range: RollRange = {
      yearCode: intent.yearCode,
      branchCode: intent.branchCode,
      division: intent.division,
      fromSerial: intent.fromSerial,
      toSerial: intent.toSerial,
    };
    const students = await studentsInRange(range);
    resolved.push({ intent, range, students });
  }

  const allStudentIds = new Set(resolved.flatMap((r) => r.students.map((s) => s.id)));
  const history = await loadHistory(prisma, exam, historyDepth, allStudentIds);

  const engineRooms: Room[] = [];
  const engineStudents: Student[] = [];
  const blocks: BlockResult[] = [];
  let merged: Assignment[] = [];

  for (const { intent, range, students } of resolved) {
    if (students.length === 0) {
      throw new UnprocessableError(
        `Block ${range.yearCode}-${range.branchCode}-${range.division} serial ${range.fromSerial}-${range.toSerial} matches no students`,
        { code: 'EMPTY_RANGE', intentId: intent.id, range },
      );
    }

    const room = intent.classroom;
    if (room.status !== 'AVAILABLE') {
      throw new UnprocessableError(`Room ${room.roomNumber} is ${room.status.toLowerCase()}`, {
        code: 'ROOM_UNAVAILABLE',
        intentId: intent.id,
        roomNumber: room.roomNumber,
      });
    }

    const required =
      intent.rowCount && intent.colCount ? intent.rowCount * intent.colCount : students.length;
    // Respect the administrator's bench window inside the room.
    const windowSeats = room.seats
      .filter((s) => s.benchNumber >= intent.seatOffset)
      .sort((a, b) => a.benchNumber - b.benchNumber)
      .slice(0, required);

    if (windowSeats.length < students.length) {
      throw new UnprocessableError(
        `Room ${room.roomNumber} offers ${windowSeats.length} bench(es) from offset ${intent.seatOffset} but ${students.length} students are in this block`,
        { code: 'ROOM_TOO_SMALL', intentId: intent.id, roomNumber: room.roomNumber, required },
      );
    }

    const roomDef: Room = {
      id: room.id,
      building: room.building,
      roomNumber: room.roomNumber,
      seats: windowSeats.map((s) => ({ id: s.id, benchNo: s.benchNumber, row: s.rowNo, col: s.colNo })),
    };

    const blockStudents: Student[] = students.map((s) => ({
      id: s.id,
      rollNo: s.rollNumber,
      departmentId: s.departmentId,
      divisionId: s.division,
    }));

    const input: EngineInput = {
      students: blockStudents,
      rooms: [roomDef],
      history,
      config: {
        mode: 'MIXED',
        // Seeded per block so two blocks in the same room differ, yet the whole
        // plan stays reproducible from the same seed.
        seed: `${seed}:${intent.id.slice(0, 8)}`,
        timeBudgetMs,
        historyDepth,
        weights: DEFAULT_WEIGHTS,
        kCandidates: 16,
        strictRollOrder: intent.strictRollOrder,
      },
    };

    const gen: EngineResult = generateSeating(input);
    if (!gen.ok) {
      throw new UnprocessableError(
        `Could not seat ${students.length} student(s) into room ${room.roomNumber}: ${gen.failure.message}`,
        { code: gen.failure.code, intentId: intent.id, roomNumber: room.roomNumber, students: students.length, failure: gen.failure },
      );
    }

    engineRooms.push(roomDef);
    engineStudents.push(...blockStudents);
    merged = merged.concat(gen.assignments);
    blocks.push({
      intentId: intent.id,
      roomNumber: room.roomNumber,
      floor: room.floor,
      cohort: `${intent.yearCode}-${intent.branchCode}-${intent.division}`,
      students: students.length,
      penalty: gen.penalty,
      strictRollOrder: intent.strictRollOrder,
    });
  }

  // Whole-plan validation: cross-block constraints must hold too.
  const mergedInput: EngineInput = {
    students: engineStudents,
    rooms: engineRooms,
    history,
    config: {
      mode: 'MIXED',
      seed,
      timeBudgetMs,
      historyDepth,
      weights: DEFAULT_WEIGHTS,
      strictRollOrder: false,
    },
  };
  const report = validate(mergedInput, merged);
  if (report.status === 'INVALID') {
    throw new UnprocessableError('The combined plan is invalid; nothing was saved.', {
      code: 'VALIDATION_FAILED',
      report,
    });
  }

  const deptByStudent = new Map(engineStudents.map((s) => [s.id, s.departmentId]));
  const totalPenalty = blocks.reduce((sum, b) => sum + b.penalty, 0);

  // Save atomically: supersede the old plan, insert the new run + allocations.
  const saved = await prisma.$transaction(async (tx) => {
    const previous = await tx.seatingRun.findMany({
      where: { examId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
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
        algorithmVersion: 'dypit-intents-v1',
        config: { source: 'allocation_intents', blocks: blocks.length, historyDepth },
        totalPenalty,
        stats: {
          blocks: blocks.length,
          roomsUsed: engineRooms.length,
          strictBlocks: blocks.filter((b) => b.strictRollOrder).length,
          totalMs: Date.now() - t0,
        },
        generatedBy: ctx.actorUserId ?? null,
      },
    });

    await tx.seatingAllocation.createMany({
      data: merged.map((a) => ({
        id: randomUUID(),
        runId,
        examId,
        studentId: a.studentId,
        classroomId: a.roomId,
        seatId: a.seatId,
        academicYearId: exam.academicYearId,
        departmentId: deptByStudent.get(a.studentId) ?? '',
      })),
    });

    await tx.exam.update({ where: { id: examId }, data: { seatingStatus: 'VALIDATED' } });
    return runId;
  });

  await auditLog({
    actorUserId: ctx.actorUserId,
    action: 'intent.generate',
    entityType: 'exam',
    entityId: examId,
    metadata: {
      runId: saved,
      subject: exam.subject,
      blocks: blocks.length,
      roomsUsed: engineRooms.length,
      seated: merged.length,
      totalPenalty,
    },
    ip: ctx.ip,
  });

  return {
    runId: saved,
    totalSeated: merged.length,
    totalPenalty,
    roomsUsed: engineRooms.length,
    blocks,
    timing: { totalMs: Date.now() - t0 },
    validation: { status: report.status, violations: report.violations.length },
  };
}

/** Read-only: what the current intents would seat, without saving anything. */
export async function explainIntents(examId: string) {
  const intents = await prisma.allocationIntent.findMany({
    where: { examId },
    include: { classroom: { include: { seats: { where: { status: 'AVAILABLE' } } } } },
    orderBy: [{ classroomId: 'asc' }, { seatOffset: 'asc' }],
  });
  if (intents.length === 0) throw new NotFoundError('No allocation intents for this exam');

  const rows = [];
  for (const intent of intents) {
    const students = await studentsInRange({
      yearCode: intent.yearCode,
      branchCode: intent.branchCode,
      division: intent.division,
      fromSerial: intent.fromSerial,
      toSerial: intent.toSerial,
    });
    const required =
      intent.rowCount && intent.colCount ? intent.rowCount * intent.colCount : students.length;
    const usable = intent.classroom.seats.filter((s) => s.benchNumber >= intent.seatOffset).length;
    rows.push({
      intentId: intent.id,
      roomNumber: intent.classroom.roomNumber,
      floor: intent.classroom.floor,
      cohort: `${intent.yearCode}-${intent.branchCode}-${intent.division}`,
      fromSerial: intent.fromSerial,
      toSerial: intent.toSerial,
      strictRollOrder: intent.strictRollOrder,
      students: students.length,
      required,
      usable,
      fits: usable >= required,
      sample: students.slice(0, 5).map((s) => ({ rollNumber: s.rollNumber, name: s.name })),
    });
  }

  const problems = rows.filter((r) => !r.fits);
  if (problems.length > 0) {
    throw new InternalError('One or more blocks no longer fit their room', { problems });
  }
  return { examId, blocks: rows, totalStudents: rows.reduce((sum, r) => sum + r.students, 0) };
}