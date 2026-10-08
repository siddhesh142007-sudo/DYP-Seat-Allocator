-- @updatedAt is maintained by the Prisma client; raw-SQL inserts would fail
-- with a NOT NULL violation without a database-level default. Give every
-- updated_at column a DEFAULT now() so both access paths behave identically.

ALTER TABLE users            ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE academic_years   ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE departments      ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE students         ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE classrooms       ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE seats            ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE exams            ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE settings         ALTER COLUMN updated_at SET DEFAULT now();
