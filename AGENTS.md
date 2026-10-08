# AGENTS.md

This file carries the permanent rules for every AI agent session working on this repository.
Source of truth: `EXAM_SEATING_BUILD_GUIDE.md` (Sections 0–7 are the permanent spec).
**Read this file plus the guide before doing anything.**

## 1. Global Rules for the AI Agent (apply to EVERY phase)

1. Build **incrementally**, phase by phase. After each phase, run the app/tests and confirm it is consistent with earlier phases. Do not rewrite working components unnecessarily.
2. **Never fake it.** No placeholder functions, no `TODO` stubs in finished phases, no hard-coded demo responses. Every endpoint reads and writes the real database.
3. After finishing a phase, **run the commands** (build, lint, typecheck, tests, migrations) and show the results. Fix failures before declaring the phase done.
4. At the end of every phase, print: (a) files created/changed, (b) commands to run it, (c) the acceptance checklist with pass/fail.
5. **Never silently create an invalid seating plan.** Any failure must be reported with a clear structured reason.
6. Keep the seating engine **pure and isolated** (no DB, no HTTP, no framework imports) so it can be improved or swapped later.
7. Use TypeScript everywhere with `strict: true`. Validate all input with Zod. Never trust the client.
8. Never commit secrets. Use `.env` + `.env.example`.
9. Keep documentation in `docs/` up to date as you go (do not leave it all for the end).
10. If a requirement is ambiguous, choose the most reasonable option, state the assumption in `docs/ASSUMPTIONS.md`, and continue. Ask me only if it is truly blocking.

## Phase discipline

- Wait for an explicit **"Run Phase N"** before starting a phase.
- Each phase ends with its acceptance checklist; do not move on until it passes.
- Useful session-restart prompt:

  ```text
  Read EXAM_SEATING_BUILD_GUIDE.md and AGENTS.md. Inspect the repo and tests,
  summarize what is complete and what is broken or missing for Phase N, then
  continue Phase N without rewriting working code.
  ```
