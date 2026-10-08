import { prisma } from '../../db/prisma.js';
import { seatingPreviewStats } from '../exams/exams.service.js';

/** Cap on upcoming exams inspected for per-exam numbers (keeps the endpoint bounded). */
const UPCOMING_SCAN_LIMIT = 40;

/** UTC midnight of today — examDate is a @db.Date column (stored at midnight). */
function startOfToday(): Date {
  return new Date(new Date().toISOString().slice(0, 10));
}

type PreviewStats = {
  eligibleCount: number;
  availableSeats: number;
  conflicts: unknown[];
};

async function upcomingExamIds(): Promise<string[]> {
  const rows = await prisma.exam.findMany({
    where: { status: 'PLANNED', examDate: { gte: startOfToday() } },
    select: { id: true },
    orderBy: { examDate: 'asc' },
    take: UPCOMING_SCAN_LIMIT,
  });
  return rows.map((r) => r.id);
}

async function previewFor(examId: string): Promise<PreviewStats | null> {
  try {
    return (await seatingPreviewStats(examId)) as PreviewStats;
  } catch {
    return null; // Exam deleted between listing and inspection.
  }
}

export async function getSummary() {
  const [totalStudents, totalDepartments, totalClassrooms, availableSeats, upcomingExams, generatedSeatingPlans, ids] =
    await Promise.all([
      prisma.student.count({ where: { status: 'ACTIVE' } }),
      prisma.department.count({ where: { status: 'ACTIVE' } }),
      prisma.classroom.count({ where: { status: 'AVAILABLE' } }),
      prisma.seat.count({ where: { status: 'AVAILABLE', classroom: { status: 'AVAILABLE' } } }),
      prisma.exam.count({ where: { status: 'PLANNED', examDate: { gte: startOfToday() } } }),
      prisma.exam.count({ where: { seatingStatus: { not: 'NOT_GENERATED' } } }),
      upcomingExamIds(),
    ]);

  let allocationConflicts = 0;
  const previews = await Promise.all(ids.map(previewFor));
  for (const preview of previews) {
    if (preview && preview.conflicts.length > 0) allocationConflicts += 1;
  }

  return {
    summary: {
      totalStudents,
      totalDepartments,
      totalClassrooms,
      availableSeats,
      upcomingExams,
      generatedSeatingPlans,
      allocationConflicts,
    },
  };
}

export async function getCharts() {
  const [departments, upcoming, plansByStatus] = await Promise.all([
    prisma.department.findMany({
      where: { status: 'ACTIVE' },
      select: { code: true, name: true, _count: { select: { students: { where: { status: 'ACTIVE' } } } } },
      orderBy: { name: 'asc' },
    }),
    prisma.exam.findMany({
      where: { status: 'PLANNED', examDate: { gte: startOfToday() } },
      select: { id: true, subject: true, examDate: true },
      orderBy: { examDate: 'asc' },
      take: 10,
    }),
    prisma.exam.groupBy({ by: ['seatingStatus'], _count: { _all: true } }),
  ]);

  const previews = await Promise.all(upcoming.map((e) => previewFor(e.id)));

  const plansByStatusAll: Record<string, number> = {
    NOT_GENERATED: 0,
    DRAFT: 0,
    VALIDATED: 0,
    PUBLISHED: 0,
  };
  for (const row of plansByStatus) plansByStatusAll[row.seatingStatus] = row._count._all;

  return {
    studentsPerDepartment: departments
      .map((d) => ({ code: d.code, name: d.name, count: d._count.students }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    seatsVsStudents: upcoming.map((e, i) => ({
      examId: e.id,
      subject: e.subject,
      examDate: e.examDate,
      eligibleCount: previews[i]?.eligibleCount ?? 0,
      availableSeats: previews[i]?.availableSeats ?? 0,
    })),
    plansByStatus: Object.entries(plansByStatusAll).map(([status, count]) => ({ status, count })),
  };
}
