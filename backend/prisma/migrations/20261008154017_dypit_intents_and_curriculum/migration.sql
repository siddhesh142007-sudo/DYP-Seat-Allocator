-- DYPIT: allocation intents + curriculum master data.
--
-- Note on updated_at: an earlier migration (20261006154439_updated_at_db_defaults)
-- deliberately added DB-level DEFAULT now() to every updated_at column so
-- raw-SQL writers (bulk imports, COPY, test fixtures) do not violate NOT NULL.
-- Prisma's diff wants to DROP those defaults because it also applies its own
-- @updatedAt. That behaviour is restored here so assumption #12 keeps holding.

-- CreateEnum
CREATE TYPE "year_code" AS ENUM ('FE', 'SE', 'TE', 'BE');

-- CreateEnum
CREATE TYPE "subject_type" AS ENUM ('THEORY', 'LABATORY', 'ELECTIVE');

-- AlterTable
ALTER TABLE "departments" ADD COLUMN "sanctioned_intake" INTEGER;

-- AlterTable
ALTER TABLE "students" ADD COLUMN "year_code" "year_code";

-- CreateTable
CREATE TABLE "subjects" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "code" VARCHAR(50),
    "department_id" UUID NOT NULL,
    "year_code" "year_code" NOT NULL,
    "semester" INTEGER NOT NULL,
    "type" "subject_type" NOT NULL DEFAULT 'THEORY',
    "group" VARCHAR(1),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocation_intents" (
    "id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "classroom_id" UUID NOT NULL,
    "year_code" "year_code" NOT NULL,
    "branch_code" VARCHAR(50) NOT NULL,
    "division" VARCHAR(50) NOT NULL,
    "from_serial" INTEGER NOT NULL,
    "to_serial" INTEGER NOT NULL,
    "row_count" INTEGER,
    "col_count" INTEGER,
    "seat_offset" INTEGER NOT NULL DEFAULT 1,
    "strict_roll_order" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allocation_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subjects_year_code_semester_idx" ON "subjects"("year_code", "semester");

-- CreateIndex
CREATE INDEX "subjects_department_id_idx" ON "subjects"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_department_id_name_year_code_semester_key" ON "subjects"("department_id", "name", "year_code", "semester");

-- CreateIndex
CREATE INDEX "allocation_intents_exam_id_idx" ON "allocation_intents"("exam_id");

-- CreateIndex
CREATE INDEX "allocation_intents_classroom_id_idx" ON "allocation_intents"("classroom_id");

-- A duplicate identical range would double-book students, so the range itself is
-- the natural key. Overlap (not just exact equality) is caught in the service.
CREATE UNIQUE INDEX "allocation_intents_exam_id_year_code_branch_code_division_f_key" ON "allocation_intents"("exam_id", "year_code", "branch_code", "division", "from_serial", "to_serial");

-- CreateIndex
CREATE INDEX "students_year_code_division_idx" ON "students"("year_code", "division");

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation_intents" ADD CONSTRAINT "allocation_intents_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation_intents" ADD CONSTRAINT "allocation_intents_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CHECK constraints
-- ---------------------------------------------------------------------------

-- Division is an A-Z letter (validated in Zod too; this is the hard backstop
-- for raw-SQL writers, matching the "every invariant is a DB constraint" rule).
ALTER TABLE "allocation_intents"
  ADD CONSTRAINT allocation_intents_division_format_ck
  CHECK ("division" ~ '^[A-Z]{1,2}$');

-- Serials are 1-based and the range must not be inverted.
ALTER TABLE "allocation_intents"
  ADD CONSTRAINT allocation_intents_serial_range_ck
  CHECK ("from_serial" >= 1 AND "to_serial" >= "from_serial");

-- Seat grid: both dimensions or neither. A single dimension is ambiguous, and
-- allowing it would silently seat a block in an undefined layout.
--
-- Written with CASE rather than "(a IS NULL AND b IS NULL) OR (a >= 1 AND b >= 1)"
-- on purpose: with one side NULL that expression yields NULL (TRUE AND NULL,
-- then FALSE OR NULL), and a CHECK constraint only rejects an explicit FALSE —
-- so a half-specified grid would silently pass. CASE always yields a boolean.
ALTER TABLE "allocation_intents"
  ADD CONSTRAINT allocation_intents_grid_ck
  CHECK (CASE
    WHEN "row_count" IS NULL AND "col_count" IS NULL THEN true
    WHEN "row_count" IS NOT NULL AND "col_count" IS NOT NULL
         AND "row_count" >= 1 AND "col_count" >= 1 THEN true
    ELSE false
  END);

ALTER TABLE "allocation_intents"
  ADD CONSTRAINT allocation_intents_seat_offset_ck
  CHECK ("seat_offset" >= 1);

-- Sanctioned intake is a count, so never negative.
ALTER TABLE "departments"
  ADD CONSTRAINT departments_sanctioned_intake_ck
  CHECK ("sanctioned_intake" IS NULL OR "sanctioned_intake" >= 0);

-- Semester is 1..8 for FE/SE/TE/BE.
ALTER TABLE "subjects"
  ADD CONSTRAINT subjects_semester_ck
  CHECK ("semester" BETWEEN 1 AND 8);

-- group is the FE Physics/Chemistry swap letter, or NULL outside FE Sem I/II.
ALTER TABLE "subjects"
  ADD CONSTRAINT subjects_group_ck
  CHECK ("group" IS NULL OR "group" IN ('A', 'B'));