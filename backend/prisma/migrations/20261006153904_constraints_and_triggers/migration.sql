-- Constraints, indexes and triggers Prisma cannot express (Section 5 of the build guide).

-- =============================================================================
-- 1. CHECK constraints
-- =============================================================================

ALTER TABLE exams
  ADD CONSTRAINT exams_end_time_after_start_time
  CHECK (end_time > start_time);

ALTER TABLE seats
  ADD CONSTRAINT seats_bench_number_positive
  CHECK (bench_number > 0);

ALTER TABLE classrooms
  ADD CONSTRAINT classrooms_capacity_non_negative
  CHECK (capacity >= 0);

ALTER TABLE students
  ADD CONSTRAINT students_roll_number_not_blank
  CHECK (btrim(roll_number) <> '');

ALTER TABLE classrooms
  ADD CONSTRAINT classrooms_room_number_not_blank
  CHECK (btrim(room_number) <> '');

-- Enum-like checks are enforced by native Postgres enum types created with
-- the tables (user_role, student_status, classroom_status, seat_status,
-- exam_status, seating_status, registration_status, run_status).

-- =============================================================================
-- 2. Partial unique index: only ONE active seating run per exam
--    (an active run is one that is neither SUPERSEDED nor FAILED)
-- =============================================================================

CREATE UNIQUE INDEX seating_runs_one_active_per_exam
  ON seating_runs (exam_id)
  WHERE status NOT IN ('SUPERSEDED', 'FAILED');

-- =============================================================================
-- 3. Trigger: a seat referenced by an allocation must belong to that
--    allocation's classroom (seat-belongs-to-room integrity).
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_check_seat_belongs_to_classroom()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM seats s
    WHERE s.id = NEW.seat_id
      AND s.classroom_id = NEW.classroom_id
  ) THEN
    RAISE EXCEPTION 'seat % does not belong to classroom %', NEW.seat_id, NEW.classroom_id
      USING ERRCODE = 'check_violation',
            HINT = 'The seat_id must be a seat of the classroom_id in the same row.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_seat_belongs_to_classroom
  BEFORE INSERT OR UPDATE OF seat_id, classroom_id ON seating_allocations
  FOR EACH ROW
  EXECUTE FUNCTION fn_check_seat_belongs_to_classroom();

-- =============================================================================
-- 4. Trigger: PUBLISHED runs and allocations are immutable (UPDATE/DELETE
--    rejected). A controlled bypass exists for the Super Admin unpublish flow:
--    call SELECT allow_published_mutation() INSIDE the same transaction —
--    the flag is transaction-local and cannot leak across transactions.
-- =============================================================================

CREATE OR REPLACE FUNCTION allow_published_mutation()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('app.allow_published_mutation', 'on', true);
END;
$$;

CREATE OR REPLACE FUNCTION fn_enforce_published_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status  run_status;
  v_bypass  text := current_setting('app.allow_published_mutation', true);
BEGIN
  IF v_bypass = 'on' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_TABLE_NAME = 'seating_runs' THEN
    IF TG_OP = 'DELETE' THEN
      v_status := OLD.status;
    ELSIF TG_OP = 'UPDATE' THEN
      v_status := OLD.status;
    ELSE
      v_status := NEW.status;
    END IF;

    IF v_status = 'PUBLISHED' AND TG_OP IN ('UPDATE', 'DELETE') THEN
      RAISE EXCEPTION 'published seating run is immutable (attempted %)', TG_OP
        USING ERRCODE = 'insufficient_privilege',
              HINT = 'Unpublish the exam first (Super Admin, with reason), then modify the run.';
    END IF;

    RETURN NEW;
  END IF;

  -- seating_allocations: check the parent run's status
  SELECT r.status INTO v_status
  FROM seating_runs r
  WHERE r.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.run_id ELSE NEW.run_id END;

  IF v_status = 'PUBLISHED' AND TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'allocations of a published seating run are immutable (attempted %)', TG_OP
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Unpublish the exam first (Super Admin, with reason), then modify the allocations.';
  END IF;

  IF v_status = 'PUBLISHED' AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'cannot add allocations to a published seating run'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Unpublish the exam first (Super Admin, with reason), then modify the allocations.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_runs_published_immutable
  BEFORE UPDATE OR DELETE ON seating_runs
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_published_immutability();

CREATE TRIGGER trg_allocations_published_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON seating_allocations
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_published_immutability();

-- =============================================================================
-- 5. Keep classroom capacity in sync with AVAILABLE seats
--    (capacity = number of available benches; broken benches reduce it)
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_refresh_classroom_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_classroom_id uuid;
BEGIN
  v_classroom_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.classroom_id
    ELSE NEW.classroom_id
  END;

  IF TG_OP = 'UPDATE' AND OLD.classroom_id IS DISTINCT FROM NEW.classroom_id THEN
    UPDATE classrooms c
    SET capacity = (SELECT count(*) FROM seats s WHERE s.classroom_id = OLD.classroom_id AND s.status = 'AVAILABLE')
    WHERE c.id = OLD.classroom_id;
  END IF;

  UPDATE classrooms c
  SET capacity = (
    SELECT count(*)
    FROM seats s
    WHERE s.classroom_id = v_classroom_id
      AND s.status = 'AVAILABLE'
  )
  WHERE c.id = v_classroom_id;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_refresh_classroom_capacity
  AFTER INSERT OR UPDATE OR DELETE ON seats
  FOR EACH ROW
  EXECUTE FUNCTION fn_refresh_classroom_capacity();
