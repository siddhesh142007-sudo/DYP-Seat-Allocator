import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { ConflictError, NotFoundError } from '../../common/errors.js';
import { formatDate, formatTime } from '../exams/exams.service.js';
import { auditLog } from '../audit/audit.service.js';
import {
  buildClassroomXlsx,
  buildDepartmentXlsx,
  buildStudentXlsx,
  buildPlanXlsx,
} from './exports.xlsx.js';
import { classroomPdf, departmentPdf, studentWisePdf, planPdf, slipPdf, bulkSlipsPdf } from './exports.pdf.js';
import {
  CSV_CONTENT_TYPE,
  DRAFT_WATERMARK,
  PDF_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  safeName,
  type ExportData,
  type ExportFile,
  type ExportFormat,
  type SeatedStudent,
} from './exports.model.js';

export * from './exports.model.js';

/**
 * Loads the exportable plan for an exam. PUBLISHED runs export cleanly;
 * VALIDATED/DRAFT runs only export when the admin explicitly opts in
 * (`includeDraft`), and then every output carries the watermark.
 */
export async function loadExport(examId: string, includeDraft: boolean): Promise<ExportData> {
  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) throw new NotFoundError('Exam not found');

  let run = await prisma.seatingRun.findFirst({
    where: { examId, status: 'PUBLISHED' },
    orderBy: { generatedAt: 'desc' },
  });
  let watermark = false;

  if (!run) {
    if (!includeDraft) {
      throw new ConflictError(
        'This exam has no PUBLISHED seating plan. Publish it first, or pass includeDraft=true to export the draft with a watermark.',
      );
    }
    run = await prisma.seatingRun.findFirst({
      where: { examId, status: { in: ['VALIDATED', 'DRAFT'] } },
      orderBy: { generatedAt: 'desc' },
    });
    if (!run) throw new ConflictError('This exam has no seating plan to export.');
    watermark = true;
  }

  const allocs = await prisma.seatingAllocation.findMany({
    where: { runId: run.id },
    include: {
      student: { select: { rollNumber: true, name: true } },
      classroom: { select: { roomNumber: true, building: true, floor: true } },
      seat: { select: { benchNumber: true } },
      department: { select: { code: true, name: true } },
    },
    orderBy: [{ classroom: { roomNumber: 'asc' } }, { seat: { benchNumber: 'asc' } }],
  });

  const rows: SeatedStudent[] = allocs.map((a) => ({
    rollNumber: a.student.rollNumber,
    studentName: a.student.name,
    departmentCode: a.department.code,
    departmentName: a.department.name,
    roomNumber: a.classroom.roomNumber,
    building: a.classroom.building,
    floor: a.classroom.floor,
    benchNumber: a.seat.benchNumber,
  }));

  const rooms: ExportData['rooms'] = [];
  const roomIndex = new Map<string, ExportData['rooms'][number]>();
  for (const row of rows) {
    let section = roomIndex.get(row.roomNumber);
    if (!section) {
      section = { roomNumber: row.roomNumber, building: row.building, floor: row.floor, students: [] };
      roomIndex.set(row.roomNumber, section);
      rooms.push(section);
    }
    section.students.push(row);
  }

  const deptMap = new Map<string, ExportData['departments'][number]>();
  for (const row of rows) {
    let section = deptMap.get(row.departmentCode);
    if (!section) {
      section = { code: row.departmentCode, name: row.departmentName, students: [] };
      deptMap.set(row.departmentCode, section);
    }
    section.students.push(row);
  }
  const departments = [...deptMap.values()].sort((a, b) => a.code.localeCompare(b.code));
  for (const dept of departments) dept.students.sort((a, b) => a.rollNumber.localeCompare(b.rollNumber));

  const byRoll = [...rows].sort((a, b) => a.rollNumber.localeCompare(b.rollNumber));

  return {
    exam: {
      id: exam.id,
      subject: exam.subject,
      paperCode: exam.paperCode,
      date: formatDate(exam.examDate),
      startTime: formatTime(exam.startTime),
      endTime: formatTime(exam.endTime),
    },
    runId: run.id,
    watermark,
    totalPenalty: run.totalPenalty,
    generatedAt: run.generatedAt,
    publishedAt: run.publishedAt,
    rooms,
    departments,
    byRoll,
    totals: { students: rows.length, rooms: rooms.length },
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function esc(value: string | number | null): string {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(cells: Array<string | number | null>): string {
  return cells.map(esc).join(',');
}

function examMetaLine(data: ExportData): string {
  return csvLine([
    'Exam',
    data.exam.subject,
    data.exam.paperCode ?? '',
    data.exam.date,
    `${data.exam.startTime}-${data.exam.endTime}`,
  ]);
}

export function classroomCsv(data: ExportData): string {
  const out: string[] = [];
  if (data.watermark) out.push(DRAFT_WATERMARK);
  out.push(examMetaLine(data));
  out.push('');
  for (const room of data.rooms) {
    out.push(csvLine(['Room', room.roomNumber, room.building ?? '', room.floor ?? '']));
    out.push(csvLine(['Bench', 'Roll No', 'Name', 'Department']));
    for (const s of room.students) out.push(csvLine([s.benchNumber, s.rollNumber, s.studentName, s.departmentCode]));
    out.push('');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

export function departmentCsv(data: ExportData): string {
  const out: string[] = [];
  if (data.watermark) out.push(DRAFT_WATERMARK);
  out.push(examMetaLine(data));
  out.push('');
  for (const dept of data.departments) {
    out.push(csvLine(['Department', dept.code, dept.name]));
    out.push(csvLine(['Roll No', 'Name', 'Room', 'Bench']));
    for (const s of dept.students) out.push(csvLine([s.rollNumber, s.studentName, s.roomNumber, s.benchNumber]));
    out.push('');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

export function studentWiseCsv(data: ExportData): string {
  const out: string[] = [];
  if (data.watermark) out.push(DRAFT_WATERMARK);
  out.push(examMetaLine(data));
  out.push(csvLine(['Roll No', 'Name', 'Department', 'Room', 'Bench']));
  for (const s of data.byRoll) {
    out.push(csvLine([s.rollNumber, s.studentName, s.departmentCode, s.roomNumber, s.benchNumber]));
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Filenames + audit
// ---------------------------------------------------------------------------

export function exportFilename(kind: string, data: ExportData, ext: string): string {
  return `seating-${kind}-${data.exam.date}-${safeName(data.exam.subject)}.${ext}`;
}

async function auditExport(
  actorId: string,
  ip: string | null,
  action: string,
  examId: string,
  metadata: Prisma.InputJsonValue,
): Promise<void> {
  await auditLog({
    actorUserId: actorId,
    action,
    entityType: 'exam',
    entityId: examId,
    metadata,
    ip,
  });
}

export interface ExportRequest {
  examId: string;
  includeDraft: boolean;
  actorId: string;
  ip: string | null;
}

function file(content: Buffer, contentType: string, filename: string): ExportFile {
  return { content, contentType, filename };
}

export async function exportClassroomWise(req: ExportRequest, format: ExportFormat): Promise<ExportFile> {
  const data = await loadExport(req.examId, req.includeDraft);
  const out =
    format === 'csv'
      ? file(Buffer.from(classroomCsv(data)), CSV_CONTENT_TYPE, exportFilename('classroom', data, 'csv'))
      : format === 'xlsx'
        ? file(await buildClassroomXlsx(data), XLSX_CONTENT_TYPE, exportFilename('classroom', data, 'xlsx'))
        : file(await classroomPdf(data), PDF_CONTENT_TYPE, exportFilename('classroom', data, 'pdf'));
  await auditExport(req.actorId, req.ip, 'export.classroom_wise', req.examId, {
    format,
    watermark: data.watermark,
    students: data.totals.students,
    rooms: data.totals.rooms,
  });
  return out;
}

export async function exportDepartmentWise(req: ExportRequest, format: ExportFormat): Promise<ExportFile> {
  const data = await loadExport(req.examId, req.includeDraft);
  const out =
    format === 'csv'
      ? file(Buffer.from(departmentCsv(data)), CSV_CONTENT_TYPE, exportFilename('department', data, 'csv'))
      : format === 'xlsx'
        ? file(await buildDepartmentXlsx(data), XLSX_CONTENT_TYPE, exportFilename('department', data, 'xlsx'))
        : file(await departmentPdf(data), PDF_CONTENT_TYPE, exportFilename('department', data, 'pdf'));
  await auditExport(req.actorId, req.ip, 'export.department_wise', req.examId, {
    format,
    watermark: data.watermark,
    departments: data.departments.length,
  });
  return out;
}

export async function exportStudentWise(req: ExportRequest, format: ExportFormat): Promise<ExportFile> {
  const data = await loadExport(req.examId, req.includeDraft);
  const out =
    format === 'csv'
      ? file(Buffer.from(studentWiseCsv(data)), CSV_CONTENT_TYPE, exportFilename('students', data, 'csv'))
      : format === 'xlsx'
        ? file(await buildStudentXlsx(data), XLSX_CONTENT_TYPE, exportFilename('students', data, 'xlsx'))
        : file(await studentWisePdf(data), PDF_CONTENT_TYPE, exportFilename('students', data, 'pdf'));
  await auditExport(req.actorId, req.ip, 'export.student_wise', req.examId, {
    format,
    watermark: data.watermark,
    students: data.totals.students,
  });
  return out;
}

export async function exportFullPlan(req: ExportRequest, format: 'pdf' | 'xlsx'): Promise<ExportFile> {
  const data = await loadExport(req.examId, req.includeDraft);
  const out =
    format === 'xlsx'
      ? file(await buildPlanXlsx(data), XLSX_CONTENT_TYPE, exportFilename('plan', data, 'xlsx'))
      : file(await planPdf(data), PDF_CONTENT_TYPE, exportFilename('plan', data, 'pdf'));
  await auditExport(req.actorId, req.ip, 'export.full_plan', req.examId, {
    format,
    watermark: data.watermark,
    students: data.totals.students,
    rooms: data.totals.rooms,
  });
  return out;
}

export async function exportSlip(req: ExportRequest, studentId: string): Promise<ExportFile> {
  const data = await loadExport(req.examId, req.includeDraft);
  const row = await prisma.seatingAllocation.findFirst({
    where: { runId: data.runId, studentId },
    include: {
      student: { select: { name: true, rollNumber: true } },
      classroom: { select: { roomNumber: true, building: true, floor: true } },
      seat: { select: { benchNumber: true } },
    },
  });
  if (!row) throw new NotFoundError('No seating found for this student in this exam');

  const out = file(
    await slipPdf(data, {
      studentName: row.student.name,
      rollNumber: row.student.rollNumber,
      roomNumber: row.classroom.roomNumber,
      building: row.classroom.building,
      floor: row.classroom.floor,
      benchNumber: row.seat.benchNumber,
    }),
    PDF_CONTENT_TYPE,
    `slip-${safeName(row.student.rollNumber)}-${data.exam.date}.pdf`,
  );
  await auditExport(req.actorId, req.ip, 'export.slip', req.examId, { studentId, watermark: data.watermark });
  return out;
}

export async function exportBulkSlips(req: ExportRequest): Promise<ExportFile> {
  const data = await loadExport(req.examId, req.includeDraft);
  const rows = await prisma.seatingAllocation.findMany({
    where: { runId: data.runId },
    include: {
      student: { select: { name: true, rollNumber: true } },
      classroom: { select: { roomNumber: true, building: true, floor: true } },
      seat: { select: { benchNumber: true } },
    },
    orderBy: { student: { rollNumber: 'asc' } },
  });
  if (rows.length === 0) throw new NotFoundError('No seating found for this exam');

  const out = file(
    await bulkSlipsPdf(
      data,
      rows.map((r) => ({
        studentName: r.student.name,
        rollNumber: r.student.rollNumber,
        roomNumber: r.classroom.roomNumber,
        building: r.classroom.building,
        floor: r.classroom.floor,
        benchNumber: r.seat.benchNumber,
      })),
    ),
    PDF_CONTENT_TYPE,
    exportFilename('slips', data, 'pdf'),
  );
  await auditExport(req.actorId, req.ip, 'export.bulk_slips', req.examId, {
    watermark: data.watermark,
    students: rows.length,
  });
  return out;
}
