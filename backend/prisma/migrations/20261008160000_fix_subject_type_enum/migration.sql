-- Fix a typo in the subject_type enum introduced by the previous migration:
-- 'LABATORY' should read 'LABORATORY'. Renamed in place rather than recreating
-- the type so already-seeded rows keep their values and no data is rewritten.

ALTER TYPE "subject_type" RENAME VALUE 'LABATORY' TO 'LABORATORY';
