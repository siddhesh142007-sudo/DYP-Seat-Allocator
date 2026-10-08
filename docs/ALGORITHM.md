# Exam Seating Algorithm (Approach C)

## Problem statement

Seat every student exactly once in an available room/bench while:

1. never exceeding room capacity (hard),
2. avoiding repeats of the previous papers' seat, room, bench number and neighbours (soft, decayed),
3. mixing departments and non-consecutive roll numbers (soft),
4. keeping room utilisation roughly balanced (soft),
5. optionally keeping each department contiguous (BLOCK mode) and capping students per
   department per room (`maxPerDepartment`).

## Comparison A/B/C

See Section 4.2 of the build guide. Chosen: **C — seeded randomized constraint-aware
greedy + swap-based local search**, because it is always feasible, reproducible by seed,
handles history in O(H) per evaluation and scales to 5,000+ students.

## Pseudocode

```
generateSeating(input):
  # 1. Feasibility (pure, no side effects) — returns a structured failure or null
  if no eligible students:            return FAIL NO_ELIGIBLE_STUDENTS
  if no available seats (enabled):    return FAIL NO_AVAILABLE_ROOMS
  if seats < students:                return FAIL INSUFFICIENT_SEATS {required, available, additionalRequired}
  if maxPerDepartment unattainable:   return FAIL DEPARTMENT_RULE_IMPOSSIBLE {departmentId, students, maxPerDepartment, reachable}

  # 2. Allocate — seeded greedy construction
  rng       = makePrng(seed)
  rooms     = shuffle(rooms, rng); sort by (usage asc, size desc)
  context   = buildContext(input)          # deptOf, rollMeta (pre-split), neighbour maps,
                                           # history index (decay d -> 0.5^(d-1)), disabled seats excluded
  students  = sort(students, historyCount desc)          # hardest first
  for s in students:
    if mode == BLOCK: seat s in the current contiguous run of its department
                      (smallest sufficient room prefix; spill to global pool if the run is full)
    else:             candidates = K sampled free seats (default 16, more early on)
                      pick argmin penaltyAt(s, seat)          # O(H), no allocations
                        + λ·Δvariance(fill%)·100             # O(1) marginal imbalance
                      honour maxPerDepartment (full-pool scan fallback)
  if any student unseated: return FAIL INSUFFICIENT_SEATS   # defensive

  # 3. Improve — time/iteration-boxed swap local search (guide §4.3)
  cur[student] = penaltyAt(each student)                    # cache
  for i in 1..min(20·N, 30000), until deadline (min(budget, 2 s)):
    a, b = two random seated students
    if mode == BLOCK and dept(a) != dept(b): continue       # blocks stay contiguous
    if swap would break maxPerDepartment:     continue
    delta = swapDelta(a, b)                                # exact O(H): both students'
           # penalties at each other's seats + neighbour-history/dept/roll deltas for
           # the (at most four) students sitting beside their old/new seats
    if delta < 0: applySwap(a, b); refresh cached penalties of the six affected seats

  # 4. Validate — independent re-check, never trusts the constructor
  report = validate(input, assignments)         # duplicate students/seats, ineligible,
                                                # unknown/disabled seats, capacity, unassigned
  if report.status == INVALID: return FAIL VALIDATION_FAILED {report}
  return OK {assignments, penalty, breakdown, stats, seed, timing}
```

`runInWorker(input)` executes the same pipeline on a `worker_threads` worker with a hard
timeout (`max(1000, timeBudgetMs) + 5000` ms → `TIMEOUT`), falling back to an inline run
if the thread cannot start.

## Scoring

| Event | Weight | Decay |
| --- | --- | --- |
| Same seat as previous paper | 100 | 0.5^(d-1) |
| Same room | 30 | 0.5^(d-1) |
| Same bench number | 10 | 0.5^(d-1) |
| Same left neighbour | 20 | 0.5^(d-1) |
| Same right neighbour | 20 | 0.5^(d-1) |
| Same-department adjacency (MIXED only) | 15 | never |
| Sequential roll-number adjacency | 5 | never |
| Room imbalance λ · variance(fill%) · 100 | λ = 1 | never |

Notes:

- `d` = rank of the previous paper with 1 = most recent. `historyDepth` caps how many
  papers are considered (env `SEATING_DEFAULT_HISTORY_DEPTH`, default 3).
- A previous paper in which the student held the *exact same seat* is a same-seat event
  only — its room/bench/neighbour fields are not counted for that paper (guide §4.4).
- `stats` (admin dashboard) count repeats against the **most recent** paper only, plus
  the number of adjacent same-department bench pairs in the final arrangement.
- `maxPerDepartment` is a per-room cap: feasibility fails with
  `DEPARTMENT_RULE_IMPOSSIBLE` when it is mathematically unattainable; construction
  enforces it best-effort with a full-pool fallback; swaps re-check it before accepting.
- BLOCK mode: students of one department are placed in contiguous bench runs (spilling
  to the next room when a run is full) and swaps are restricted to same-department pairs.

## Complexity

- Feasibility: O(R + S)
- Construction: O(N·K·H + S log S)
- Improvement: O(I·H), I ≤ min(20·N, 30 000), each delta O(H) with no arrangement copies
- Validation: O(N + S)
- Space: O(N + S + H·N)

## Benchmarks

Measured with `tsx` on the development machine (history: 2 previous papers, MIXED mode,
best of 5 runs after warm-up):

| Students | Rooms / Seats | Total | Allocate | Improve | Validate |
| --- | --- | --- | --- | --- | --- |
| 10 | 1 / 20 | 2 ms | 0 ms | 2 ms | 0 ms |
| 100 | 2 / 120 | 13 ms | 3 ms | 9 ms | 1 ms |
| 1 000 | 20 / 1 200 | 223 ms | 35 ms | 186 ms | 2 ms |
| 5 000 | 100 / 6 000 | 1 139 ms | 462 ms | 668 ms | 9 ms |
| 10 000 (stretch) | 140 / 11 200 | 3 759 ms | 1 846 ms | 1 885 ms | 28 ms |

The engine test suite asserts 5,000 students finish in under 2 000 ms, and the service
keeps the whole request inside `SEATING_TIME_BUDGET_MS` (default 10 000 ms) via the
worker timeout.

## Demo output (60-student example)

Produced by `npm run demo:algorithm` (from `backend/`):

```text
Exam seating demo — 60 students (20 per department), 3 rooms x 20 benches, 3 papers, MIXED mode.
Weights: sameSeat 100, sameRoom 30, sameBenchNo 10, sameNeighbour 20, sameDeptAdjacent 15, imbalance 1, sequentialRoll 5.

=== Paper 1 ===
          1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20
ROOM1   S05 S28 S08 S10 S30 S38 S31 S12 S22 S06 S40 S50 S57 S44 S49 S15 S23 S55 S51 S14
ROOM2   S19 S54 S04 S48 S53 S25 S27 S07 S24 S52 S60 S13 S47 S37 S56 S33 S41 S46 S29 S42
ROOM3   S21 S02 S34 S17 S39 S11 S01 S35 S58 S32 S36 S59 S18 S43 S09 S20 S45 S16 S26 S03
penalty: 0   repeats vs previous paper: sameSeat 0, sameRoom 0, sameBenchNo 0, sameNeighbour 0, sameDeptAdjacent 0

=== Paper 2 ===
          1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20
ROOM1   S29 S46 S33 S26 S60 S37 S47 S34 S42 S20 S54 S19 S36 S32 S45 S04 S35 S25 S59 S13
ROOM2   S23 S49 S44 S51 S58 S08 S55 S03 S17 S21 S01 S09 S05 S18 S11 S39 S16 S02 S43 S12
ROOM3   S53 S07 S30 S52 S56 S28 S06 S14 S27 S22 S38 S15 S40 S48 S31 S41 S24 S10 S57 S50
penalty: 0   repeats vs previous paper: sameSeat 0, sameRoom 0, sameBenchNo 0, sameNeighbour 0, sameDeptAdjacent 0

--- Paper 2 vs Paper 1 ---
students who changed room: 60/60

How history influenced this paper:
  - Student S01 was in ROOM3 bench 7; this paper the engine penalised ROOM3 and bench 7 and placed them in ROOM2 bench 11.
  - Student S02 was in ROOM3 bench 2; this paper the engine penalised ROOM3 and bench 2 and placed them in ROOM2 bench 18.
  - Student S03 was in ROOM3 bench 20; this paper the engine penalised ROOM3 and bench 20 and placed them in ROOM2 bench 8.
  - Student S04 was in ROOM2 bench 3; this paper the engine penalised ROOM2 and bench 3 and placed them in ROOM1 bench 16.

=== Paper 3 ===
          1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20
ROOM1   S27 S11 S07 S39 S43 S56 S24 S53 S16 S09 S48 S41 S03 S01 S17 S58 S21 S52 S02 S18
ROOM2   S13 S26 S15 S28 S36 S14 S22 S57 S10 S59 S30 S25 S38 S40 S06 S31 S50 S34 S45 S32
ROOM3   S51 S05 S12 S47 S33 S49 S20 S37 S54 S29 S19 S35 S55 S08 S04 S23 S42 S44 S60 S46
penalty: 90   repeats vs previous paper: sameSeat 0, sameRoom 0, sameBenchNo 0, sameNeighbour 0, sameDeptAdjacent 1

--- Paper 3 vs Paper 2 ---
students who changed room: 60/60

How history influenced this paper:
  - Student S01 was in ROOM2 bench 11; this paper the engine penalised ROOM2 and bench 11 and placed them in ROOM1 bench 14.
  - Student S02 was in ROOM2 bench 18; this paper the engine penalised ROOM2 and bench 18 and placed them in ROOM1 bench 19.
  - Student S03 was in ROOM2 bench 8; this paper the engine penalised ROOM2 and bench 8 and placed them in ROOM1 bench 13.
  - Student S04 was in ROOM1 bench 16; this paper the engine penalised ROOM1 and bench 16 and placed them in ROOM3 bench 15.
```

Each paper is a completely different arrangement; by Paper 3 the engine must balance two
previous papers against each other, which is why a small residual penalty (one
same-department adjacency plus unavoidable roll-number adjacencies) remains.

## Failure modes

The engine never returns a silently invalid plan. Every failure carries a code and
details (Section 3.8 of the guide):

| Code | Details | Meaning |
| --- | --- | --- |
| `NO_ELIGIBLE_STUDENTS` | — | empty student list |
| `NO_AVAILABLE_ROOMS` | — | no rooms, or every seat is disabled |
| `INSUFFICIENT_SEATS` | `{required, available, additionalRequired}` | not enough enabled seats |
| `DEPARTMENT_RULE_IMPOSSIBLE` | `{departmentId, students, maxPerDepartment, reachable}` | the per-room department cap cannot hold this department |
| `VALIDATION_FAILED` | `{report}` | independent validator rejected the generated plan |
| `TIMEOUT` | — | `runInWorker` exceeded the hard worker deadline |

## Test coverage

`backend/tests/engine/engine.test.ts` (27 tests): basic seating at sizes 10/100/1 000/5 000,
exact fit, structured insufficient-seat failure, edge cases (zero students, zero rooms, all
seats disabled, unequal department sizes, department larger than any room, single room with
exactly N seats → unavoidable repeats *reported* rather than failed), `maxPerDepartment`
feasible/impossible, disabled-seat exclusion, independent-validator check, 200-input fuzz
for the hard invariants, BLOCK contiguity, improve-never-worsens, history-aware vs
history-blind repetition counts, three consecutive papers with a statistical threshold
against the Approach-A baseline (paper 3 avoids seat repeats against **both** previous
papers), seed determinism/divergence, stats/timing population, and `runInWorker`
equivalence.
