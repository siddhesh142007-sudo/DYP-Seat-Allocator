import { makePrng } from './prng.js';
import type { EngineInput, EngineResult } from './types.js';
import { applySwap, buildContext, penaltyAt, place, scoreSolution, seatKey, swapDelta, type ScoringContext } from './scoring.js';

function rebuildContext(input: EngineInput, roomIds: Set<string>): ScoringContext {
  const rooms = input.rooms
    .filter((r) => roomIds.has(r.id))
    .map((r) => ({ ...r, seats: r.seats.filter((s) => s.status !== 'DISABLED') }));
  return buildContext({ ...input, rooms });
}

/**
 * Time-boxed swap-based local search (guide §4.3 step 5). Picks two random
 * seated students, evaluates the O(H) delta penalty of exchanging their seats
 * and accepts the swap only when the total penalty strictly drops.
 *
 * Hard constraints survive every swap by construction (the two students only
 * exchange seats). BLOCK mode additionally restricts swaps to a single
 * department so contiguous department blocks stay contiguous, and
 * maxPerDepartment is never broken.
 */
export function improve(input: EngineInput, res: EngineResult): EngineResult {
  if (!res.ok) return res;
  const t0 = Date.now();
  const studentIds = res.assignments.map((a) => a.studentId);
  const n = studentIds.length;
  if (n < 2) return res;

  const roomIds = new Set(res.assignments.map((a) => a.roomId));
  const ctx = rebuildContext(input, roomIds);
  for (const a of res.assignments) place(ctx, a);

  const rng = makePrng(`${res.seed}::improve`);
  // Guide §4.3: local search runs "for a time/iteration budget (e.g. max 2 s or
  // 20·N iterations)". The iteration cap is additionally clamped so a 5,000
  // student generation stays well inside the 2 s search box: gains flatten out
  // long before 20·N at that scale.
  const maxIter = Math.min(20 * n, 30000);
  const budget = Math.min(Math.max(0, input.config.timeBudgetMs - res.timing.allocateMs), 2000);
  const deadline = t0 + budget;
  const cap = input.config.maxPerDepartment ?? null;
  const blockOnly = input.config.mode === 'BLOCK';

  // Cached current penalty per student. A swap only changes the two movers and
  // the students adjacent to their seats, so rejected swaps (the common case)
  // read two cached numbers instead of re-evaluating both students, and
  // accepted swaps refresh only the six possibly-affected seats.
  const cur = new Map<string, number>();
  for (const s of ctx.assigned.values()) cur.set(s.studentId, penaltyAt(ctx, s.studentId, s.roomId, s.seatId, s.benchNo));
  const refreshSeat = (seatK: string): void => {
    const id = ctx.occupant.get(seatK);
    if (!id) return;
    const as = ctx.assigned.get(id);
    if (as) cur.set(id, penaltyAt(ctx, id, as.roomId, as.seatId, as.benchNo));
  };

  const capAllows = (a: { studentId: string; roomId: string }, b: { studentId: string; roomId: string }): boolean => {
    if (cap == null || a.roomId === b.roomId) return true;
    const dA = ctx.deptOf.get(a.studentId);
    const dB = ctx.deptOf.get(b.studentId);
    if (!dA || !dB || dA === dB) return true;
    const inRoom = (dept: string, roomId: string): number => ctx.deptRoomCount.get(`${dept}::${roomId}`) ?? 0;
    return inRoom(dA, b.roomId) + 1 <= cap && inRoom(dB, a.roomId) + 1 <= cap;
  };

  let iterations = 0;
  while (iterations < maxIter) {
    // Check the deadline every iteration: sampling it only every 128 rounds
    // let the search overshoot its budget by seconds on a loaded machine.
    if (Date.now() >= deadline) break;
    iterations++;
    const i = Math.floor(rng() * n);
    let j = Math.floor(rng() * (n - 1));
    if (j >= i) j += 1;
    const a = ctx.assigned.get(studentIds[i]!);
    const b = ctx.assigned.get(studentIds[j]!);
    if (!a || !b || a.studentId === b.studentId) continue;
    if (blockOnly && ctx.deptOf.get(a.studentId) !== ctx.deptOf.get(b.studentId)) continue;
    if (!capAllows(a, b)) continue;
    const ca = cur.get(a.studentId);
    const cb = cur.get(b.studentId);
    const before = ca !== undefined && cb !== undefined ? ca + cb : undefined;
    if (swapDelta(ctx, a, b, before) < 0) {
      const kA = seatKey(a.roomId, a.seatId);
      const kB = seatKey(b.roomId, b.seatId);
      const sideSeats = [
        ctx.leftSeat.get(kA) ?? null,
        ctx.rightSeat.get(kA) ?? null,
        ctx.leftSeat.get(kB) ?? null,
        ctx.rightSeat.get(kB) ?? null,
      ];
      applySwap(ctx, a, b);
      refreshSeat(kA);
      refreshSeat(kB);
      for (const k of sideSeats) if (k) refreshSeat(k);
    }
  }

  const scored = scoreSolution(ctx);
  const t1 = Date.now();
  const improveMs = t1 - t0;
  return {
    ...res,
    assignments: [...ctx.assigned.values()].sort((x, y) =>
      x.studentId < y.studentId ? -1 : x.studentId > y.studentId ? 1 : 0,
    ),
    penalty: scored.penalty,
    breakdown: scored.breakdown,
    stats: { ...scored.stats, timeMs: res.stats.timeMs, iterations },
    timing: { ...res.timing, improveMs, totalMs: res.timing.allocateMs + improveMs },
  };
}
