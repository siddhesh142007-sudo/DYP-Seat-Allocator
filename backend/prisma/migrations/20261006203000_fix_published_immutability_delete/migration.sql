-- Fix: fn_enforce_published_immutability returned NEW for every triggering row.
-- For DELETE, NEW is NULL, so deleting (or cascade-deleting) non-PUBLISHED runs
-- and allocations silently did nothing. Only PUBLISHED rows are immutable;
-- everything else must pass through OLD (DELETE) / NEW (INSERT, UPDATE).

CREATE OR REPLACE FUNCTION public.fn_enforce_published_immutability()
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

    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
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

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;