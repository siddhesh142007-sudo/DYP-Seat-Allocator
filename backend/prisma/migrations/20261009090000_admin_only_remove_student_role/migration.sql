-- DYPIT is an administrator-only system: no student login, no student portal.
--
-- Students remain as records (they are seated), but they no longer have user
-- accounts, so the STUDENT role is removed from the enum entirely rather than
-- left behind as an unused login path.
--
-- Refresh tokens are stateless JWTs revoked by `users.token_version`, so
-- deleting the account invalidates them automatically - there is no token
-- table to clean up.

-- Audit rows written by a student keep their content; only the (now missing)
-- actor is cleared rather than deleting the trail.
UPDATE audit_logs SET actor_user_id = NULL
 WHERE actor_user_id IN (SELECT id FROM users WHERE role = 'STUDENT');

-- users.student_id is the FK to students, so deleting the user row is enough;
-- the student record itself survives.
DELETE FROM users WHERE role = 'STUDENT';

-- PostgreSQL has no "ALTER TYPE ... DROP VALUE", so the enum is rebuilt and the
-- column is moved across. USING role::text::user_role_new is safe only because
-- every STUDENT row was just deleted.
CREATE TYPE "user_role_new" AS ENUM ('SUPER_ADMIN', 'EXAM_ADMIN');

ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users"
  ALTER COLUMN "role" TYPE "user_role_new" USING "role"::text::"user_role_new";

DROP TYPE "user_role";

-- The column now holds user_role_new, so the replacement is *renamed* onto the
-- original name rather than converted back to it.
ALTER TYPE "user_role_new" RENAME TO "user_role";