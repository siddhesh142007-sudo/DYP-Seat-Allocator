import PDFDocument from 'pdfkit';
import { prisma } from '../../db/prisma.js';
import { NotFoundError } from '../../common/errors.js';
import { drawSlip, shortStamp } from '../../common/pdfSlip.js';
import { formatDate, formatTime } from '../exams/exams.service.js';

/** Everything the portal needs to render one exam card. */
export interface MySeatingCard {
  examId: string;
  subject: string;
  paperCode: string | null;
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'HH:mm' 24-hour */
  startTime: string;
  /** 'HH:mm' 24-hour */
  endTime: string;
  room: {
    roomNumber: string;
    building: string | null;
    floor: string | null;
  };
  benchNumber: number;
  publishedAt: string | null;
}

export interface MySeatingResponse {
  upcoming: MySeatingCard[];
  past: MySeatingCard[];
}

const ALLOCATION_INCLUDE = {
  exam: {
    select: {
      id: true,
      subject: true,
      paperCode: true,
      examDate: true,
      startTime: true,
      endTime: true,
    },
  },
  classroom: { select: { roomNumber: true, building: true, floor: true } },
  seat: { select: { benchNumber: true } },
  run: { select: { publishedAt: true } },
} as const;

type AllocationRow = {
  exam: {
    id: string;
    subject: string;
    paperCode: string | null;
    examDate: Date;
    startTime: Date;
    endTime: Date;
  };
  classroom: { roomNumber: string; building: string | null; floor: string | null };
  seat: { benchNumber: number };
  run: { publishedAt: Date | null };
};

function toCard(row: AllocationRow): MySeatingCard {
  return {
    examId: row.exam.id,
    subject: row.exam.subject,
    paperCode: row.exam.paperCode,
    date: formatDate(row.exam.examDate),
    startTime: formatTime(row.exam.startTime),
    endTime: formatTime(row.exam.endTime),
    room: {
      roomNumber: row.classroom.roomNumber,
      building: row.classroom.building,
      floor: row.classroom.floor,
    },
    benchNumber: row.seat.benchNumber,
    publishedAt: row.run.publishedAt?.toISOString() ?? null,
  };
}

/** An exam is in the past once its end time has passed (server clock). */
function isPast(card: MySeatingCard): boolean {
  const end = new Date(`${card.date}T${card.endTime}:00`);
  return end.getTime() <= Date.now();
}

/**
 * All PUBLISHED seatings belonging to `studentId`, split into upcoming and
 * past. Draft / validated / superseded runs are never returned — a plan the
 * admin has not published does not exist for the student.
 */
export async function mySeating(studentId: string): Promise<MySeatingResponse> {
  const rows = await prisma.seatingAllocation.findMany({
    where: { studentId, run: { status: 'PUBLISHED' } },
    include: ALLOCATION_INCLUDE,
    orderBy: [{ exam: { examDate: 'asc' } }, { exam: { startTime: 'asc' } }],
  });

  const cards = rows.map(toCard);
  return {
    upcoming: cards.filter((c) => !isPast(c)),
    past: cards.filter(isPast),
  };
}

/**
 * Renders the student's own seating slip for one exam as a PDF buffer.
 * 404 when no PUBLISHED allocation exists for this student + exam — drafts
 * and other students' exams are indistinguishable from "not found".
 */
export async function mySlip(
  studentId: string,
  examId: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const alloc = await prisma.seatingAllocation.findFirst({
    where: { studentId, examId, run: { status: 'PUBLISHED' } },
    include: {
      ...ALLOCATION_INCLUDE,
      student: { select: { name: true, rollNumber: true } },
    },
  });
  if (!alloc) throw new NotFoundError('No published seating found for this exam');

  const card = toCard(alloc);

  const doc = new PDFDocument({ size: 'A4', margin: 50, compress: false });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => doc.on('end', () => resolve()));

  drawSlip(
    doc,
    {
      studentName: alloc.student.name,
      rollNumber: alloc.student.rollNumber,
      subject: card.subject,
      paperCode: card.paperCode,
      date: card.date,
      startTime: card.startTime,
      endTime: card.endTime,
      roomNumber: card.room.roomNumber,
      building: card.room.building,
      floor: card.room.floor,
      benchNumber: card.benchNumber,
      publishedStamp: shortStamp(alloc.run.publishedAt),
      generatedStamp: shortStamp(new Date()) ?? '',
    },
    { x: 50, y: 70, width: 495, height: 460 },
    { footer: true, bordered: false },
  );

  doc.end();
  await finished;
  return { buffer: Buffer.concat(chunks), filename: slipFilename(card) };
}

/** Safe ASCII filename for the Content-Disposition header. */
export function slipFilename(card: MySeatingCard): string {
  const raw = `seating-slip-${card.room.roomNumber}-bench-${card.benchNumber}-${card.date}.pdf`;
  return raw.replace(/[^A-Za-z0-9.-]+/g, '-');
}
