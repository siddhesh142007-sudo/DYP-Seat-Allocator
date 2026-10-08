# Database documentation

- `ER_DIAGRAM.md` — Mermaid ER diagram + relationship/constraint explanations (Phase 2)
- `SCHEMA.md` — table/column reference (Phase 2)

The schema itself lives in `backend/prisma/schema.prisma` plus raw SQL migrations in
`backend/prisma/migrations/` (CHECK constraints, partial unique indexes, immutability triggers).
