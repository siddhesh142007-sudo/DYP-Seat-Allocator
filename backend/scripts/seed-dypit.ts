/* eslint-disable no-console */
/**
 * Seeds DYPIT master data: 10 branches with sanctioned intake, the SPPU
 * curriculum per branch, and the First Year Physics/Chemistry subject
 * directory.
 *
 *   npm run seed:dypit
 *
 * Idempotent: re-running updates departments and upserts subjects by
 * (department, name, yearCode, semester). Existing students, exams and seating
 * runs are never touched.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/db/prisma.js';
import {
  DYPIT_BRANCHES,
  parseIntakeTable,
  parseHandbook,
  parseFeDirectory,
  type CurriculumSubject,
} from '../src/modules/dypit/curriculum.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(here, '..', 'seed-data');
const HANDBOOK = join(SEED_DIR, 'curriculum-handbook.csv');
const FE_DIR = join(SEED_DIR, 'fe-subjects.csv');

/** Maps parsed subject kinds onto the DB enum values. */
const KIND_TO_ENUM = {
  THEORY: 'THEORY',
  LABORATORY: 'LABORATORY',
  ELECTIVE: 'ELECTIVE',
} as const;

function readSource(path: string, label: string): string | null {
  if (!existsSync(path)) {
    console.warn(`⚠ ${label} not found at ${path} — skipping.`);
    return null;
  }
  return readFileSync(path, 'utf8');
}

async function main(): Promise<void> {
  console.log('🌱 Seeding DYPIT master data...');

  const handbook = readSource(HANDBOOK, 'curriculum handbook');
  const feCsv = readSource(FE_DIR, 'FE subject directory');
  if (!handbook && !feCsv) {
    throw new Error(`No curriculum sources found under ${SEED_DIR}`);
  }

  // --- Sanctioned intake (authoritative) ---
  let intakeByCode = new Map<string, number>();
  if (handbook) {
    const intake = parseIntakeTable(handbook);
    console.log(`  intake table: ${intake.rows.length} branches, ${intake.total} seats`);
    intakeByCode = new Map(
      DYPIT_BRANCHES.filter((b) => intake.rows.some((r) => r.name === b.name)).map((b) => {
        const row = intake.rows.find((r) => r.name === b.name)!;
        return [b.code, row.seats] as const;
      }),
    );
  }
  // Fall back to the published table if the CSV could not be read.
  for (const b of DYPIT_BRANCHES) {
    if (!intakeByCode.has(b.code)) intakeByCode.set(b.code, b.seats);
  }

  // --- Departments (branches) ---
  const deptByCode = new Map<string, string>();
  for (const branch of DYPIT_BRANCHES) {
    const seats = intakeByCode.get(branch.code) ?? branch.seats;
    const dept = await prisma.department.upsert({
      where: { code: branch.code },
      update: { name: branch.name, sanctionedIntake: seats },
      create: { code: branch.code, name: branch.name, sanctionedIntake: seats },
    });
    deptByCode.set(branch.code, dept.id);
  }
  const totalIntake = [...intakeByCode.values()].reduce((a, b) => a + b, 0);
  console.log(`✓ ${deptByCode.size} branches upserted (total sanctioned intake ${totalIntake})`);

  // --- Curriculum subjects ---
  let subjectCount = 0;
  const upsertSubject = async (
    departmentId: string,
    s: CurriculumSubject,
  ): Promise<void> => {
    await prisma.subject.upsert({
      where: {
        departmentId_name_yearCode_semester: {
          departmentId,
          name: s.name,
          yearCode: s.yearCode,
          semester: s.semester,
        },
      },
      update: { type: KIND_TO_ENUM[s.kind], group: s.group ?? null },
      create: {
        departmentId,
        name: s.name,
        yearCode: s.yearCode,
        semester: s.semester,
        type: KIND_TO_ENUM[s.kind],
        group: s.group ?? null,
      },
    });
    subjectCount++;
  };

  if (handbook) {
    for (const branch of parseHandbook(handbook)) {
      const departmentId = deptByCode.get(branch.branchCode);
      if (!departmentId) {
        console.warn(`  ⚠ no department for branch ${branch.branchCode} — skipping its subjects`);
        continue;
      }
      for (const subject of branch.subjects) {
        await upsertSubject(departmentId, subject);
      }
      console.log(`  ${branch.branchCode.padEnd(6)} ${branch.subjects.length} subjects`);
    }
  }

  // --- FE directory is common to all branches ---
  if (feCsv) {
    const feSubjects = parseFeDirectory(feCsv);
    // FE papers are common, so attach them to the first branch and treat the
    // rest as copies for reference. Seating never reads subjects, so this
    // keeps the table small while still exposing the curriculum in the UI.
    const host = deptByCode.get('CE');
    if (host) {
      for (const subject of feSubjects) {
        await upsertSubject(host, subject);
      }
    }
    const bySemester = feSubjects.reduce<Record<number, number>>((acc, s) => {
      acc[s.semester] = (acc[s.semester] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `✓ FE subjects: ${feSubjects.length} (Sem I ${bySemester[1] ?? 0}, Sem II ${bySemester[2] ?? 0}; Physics/Chemistry groups A+B)`,
    );
  }

  console.log(`✓ ${subjectCount} curriculum subjects upserted`);
  console.log('\nDYPIT master data seeded. Branch codes: ' + DYPIT_BRANCHES.map((b) => b.code).join(', '));
}

main()
  .catch((err) => {
    console.error('DYPIT seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());