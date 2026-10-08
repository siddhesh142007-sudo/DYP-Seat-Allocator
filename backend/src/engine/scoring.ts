import type { Assignment, Breakdown, EngineInput, Stats } from './types.js';
import { buildHistoryIndex, decay, type HistIndex } from './history.js';

export function seatKey(roomId: string, seatId: string): string {
  return `${roomId}::${seatId}`;
}

export type ScoringContext = {
  input: EngineInput;
  hist: HistIndex;
  /** Hoisted from input.config — read on every penalty evaluation. */
  weights: EngineInput['config']['weights'];
  mode: EngineInput['config']['mode'];
  deptOf: Map<string, string>;
  /** Pre-split roll number (prefix, trailing number) so swaps never run regex. */
  rollMeta: Map<string, [string, number] | null>;
  /** seatKey -> studentId currently seated there. */
  occupant: Map<string, string>;
  leftSeat: Map<string, string | null>;
  rightSeat: Map<string, string | null>;
  roomSize: Map<string, number>;
  roomUsed: Map<string, number>;
  assigned: Map<string, Assignment>;
  totalSeats: number;
  /** `${deptId}::${roomId}` -> students of that department in that room (maxPerDepartment). */
  deptRoomCount: Map<string, number>;
};

/**
 * Optional seat-occupant overrides used to score a hypothetical arrangement
 * (swaps). A plain scalar pair instead of a Map: the hot swap path replaces
 * exactly two seats, and hashing a Map per iteration dominated the profile.
 */
export type OccupantOverride = { k1: string; v1: string; k2: string; v2: string };

const TRAILING_DIGITS = /(\d+)$/;

function rollPrefixAndNumber(roll: string | undefined): [string, number] | null {
  if (!roll) return null;
  const m = TRAILING_DIGITS.exec(roll);
  if (!m || m.index === 0) return null;
  return [roll.slice(0, m.index), Number(m[1])];
}

/** True when two roll numbers share a prefix and differ by exactly 1 (…001 / …002). */
function consecutiveRolls(a: [string, number] | null, b: [string, number] | null): boolean {
  return Boolean(a && b && a[0] === b[0] && Math.abs(a[1] - b[1]) === 1);
}

export function zeroBreakdown(): Breakdown {
  return {
    sameSeat: 0,
    sameRoom: 0,
    sameBenchNo: 0,
    sameNeighbour: 0,
    sameDeptAdjacent: 0,
    imbalance: 0,
    sequentialRoll: 0,
  };
}

export function buildContext(input: EngineInput): ScoringContext {
  const deptOf = new Map<string, string>();
  const rollMeta = new Map<string, [string, number] | null>();
  for (const s of input.students) {
    deptOf.set(s.id, s.departmentId);
    rollMeta.set(s.id, rollPrefixAndNumber(s.rollNo));
  }

  const leftSeat = new Map<string, string | null>();
  const rightSeat = new Map<string, string | null>();
  const roomSize = new Map<string, number>();
  const roomUsed = new Map<string, number>();
  let totalSeats = 0;

  for (const room of input.rooms) {
    const seats = room.seats.filter((s) => s.status !== 'DISABLED').sort((a, b) => a.benchNo - b.benchNo);
    roomSize.set(room.id, seats.length);
    roomUsed.set(room.id, 0);
    totalSeats += seats.length;
    seats.forEach((s, i) => {
      const k = seatKey(room.id, s.id);
      const prev = i > 0 ? seats[i - 1] : undefined;
      const next = i < seats.length - 1 ? seats[i + 1] : undefined;
      leftSeat.set(k, prev ? seatKey(room.id, prev.id) : null);
      rightSeat.set(k, next ? seatKey(room.id, next.id) : null);
    });
  }

  return {
    input,
    hist: buildHistoryIndex(input.history, input.config.historyDepth),
    weights: input.config.weights,
    mode: input.config.mode,
    deptOf,
    rollMeta,
    occupant: new Map(),
    leftSeat,
    rightSeat,
    roomSize,
    roomUsed,
    assigned: new Map(),
    totalSeats,
    deptRoomCount: new Map(),
  };
}

function neighboursOf(ctx: ScoringContext, key: string): [string | null, string | null] {
  const left = ctx.leftSeat.get(key) ?? null;
  const right = ctx.rightSeat.get(key) ?? null;
  return [left == null ? null : ctx.occupant.get(left) ?? null, right == null ? null : ctx.occupant.get(right) ?? null];
}

/**
 * Penalty of seating `studentId` at the given seat in the arrangement described by
 * `ctx` (plus `ov` overrides). Pure: never mutates the context. When `sink` is
 * given the per-rule components are accumulated into it (used by the full rescore).
 *
 * Previous-paper events (same seat/room/bench, neighbours) are decayed by 0.5^(d-1)
 * per Section 4.4 of the guide. Arrangement events (same-department adjacency,
 * sequential roll numbers) are not previous-paper events and are never decayed.
 * Same-department adjacency is only penalised in MIXED mode: in BLOCK mode
 * department contiguity is the goal, not a penalty.
 *
 * This is the hot path of both construction and local search: no allocations,
 * no regex (roll numbers are pre-split in the context).
 */
export function penaltyAt(
  ctx: ScoringContext,
  studentId: string,
  roomId: string,
  seatId: string,
  benchNo: number,
  ov?: OccupantOverride,
  sink?: Breakdown,
): number {
  const w = ctx.weights;
  const key = seatKey(roomId, seatId);
  const lk = ctx.leftSeat.get(key) ?? null;
  const rk = ctx.rightSeat.get(key) ?? null;
  let leftId: string | null = null;
  if (lk != null) {
    if (ov && lk === ov.k1) leftId = ov.v1;
    else if (ov && lk === ov.k2) leftId = ov.v2;
    else leftId = ctx.occupant.get(lk) ?? null;
  }
  let rightId: string | null = null;
  if (rk != null) {
    if (ov && rk === ov.k1) rightId = ov.v1;
    else if (ov && rk === ov.k2) rightId = ov.v2;
    else rightId = ctx.occupant.get(rk) ?? null;
  }
  let p = 0;

  const history = ctx.hist.byStudent.get(studentId);
  if (history) {
    for (const item of history) {
      const a = item.a;
      const d = decay(item.d);
      if (a.roomId === roomId && a.seatId === seatId) {
        const v = w.sameSeat * d;
        p += v;
        if (sink) sink.sameSeat += v;
        continue;
      }
      if (a.roomId === roomId) {
        const v = w.sameRoom * d;
        p += v;
        if (sink) sink.sameRoom += v;
      }
      if (a.benchNo === benchNo) {
        const v = w.sameBenchNo * d;
        p += v;
        if (sink) sink.sameBenchNo += v;
      }
      if (leftId && a.leftNeighbourId && leftId === a.leftNeighbourId) {
        const v = w.sameLeftNeighbour * d;
        p += v;
        if (sink) sink.sameNeighbour += v;
      }
      if (rightId && a.rightNeighbourId && rightId === a.rightNeighbourId) {
        const v = w.sameRightNeighbour * d;
        p += v;
        if (sink) sink.sameNeighbour += v;
      }
    }
  }

  const myDept = ctx.deptOf.get(studentId);
  if (myDept && ctx.mode === 'MIXED') {
    if (leftId && ctx.deptOf.get(leftId) === myDept) {
      p += w.sameDeptAdjacent;
      if (sink) sink.sameDeptAdjacent += w.sameDeptAdjacent;
    }
    if (rightId && ctx.deptOf.get(rightId) === myDept) {
      p += w.sameDeptAdjacent;
      if (sink) sink.sameDeptAdjacent += w.sameDeptAdjacent;
    }
  }

  const myRoll = ctx.rollMeta.get(studentId) ?? null;
  if (myRoll) {
    if (leftId) {
      const other = ctx.rollMeta.get(leftId) ?? null;
      if (other && consecutiveRolls(myRoll, other)) {
        p += w.sequentialRoll;
        if (sink) sink.sequentialRoll += w.sequentialRoll;
      }
    }
    if (rightId) {
      const other = ctx.rollMeta.get(rightId) ?? null;
      if (other && consecutiveRolls(myRoll, other)) {
        p += w.sequentialRoll;
        if (sink) sink.sequentialRoll += w.sequentialRoll;
      }
    }
  }

  return p;
}

export function place(ctx: ScoringContext, a: Assignment): void {
  const key = seatKey(a.roomId, a.seatId);
  ctx.occupant.set(key, a.studentId);
  ctx.assigned.set(a.studentId, a);
  ctx.roomUsed.set(a.roomId, (ctx.roomUsed.get(a.roomId) ?? 0) + 1);
  const dr = `${ctx.deptOf.get(a.studentId) ?? '?'}::${a.roomId}`;
  ctx.deptRoomCount.set(dr, (ctx.deptRoomCount.get(dr) ?? 0) + 1);
}

export function removeStudent(ctx: ScoringContext, studentId: string): Assignment | null {
  const a = ctx.assigned.get(studentId);
  if (!a) return null;
  ctx.occupant.delete(seatKey(a.roomId, a.seatId));
  ctx.assigned.delete(studentId);
  ctx.roomUsed.set(a.roomId, Math.max(0, (ctx.roomUsed.get(a.roomId) ?? 1) - 1));
  const dr = `${ctx.deptOf.get(studentId) ?? '?'}::${a.roomId}`;
  ctx.deptRoomCount.set(dr, Math.max(0, (ctx.deptRoomCount.get(dr) ?? 1) - 1));
  return a;
}

/**
 * Penalty change for a student `nId` who stays seated while the occupant of one
 * of their neighbour seats changes `oldId -> newId`. `side` says which of n's
 * neighbour slots changed. Only neighbour-dependent terms can move: repeated
 * neighbour history, department adjacency (MIXED), sequential roll numbers.
 *
 * Mirrors `penaltyAt` precedence: a previous paper in which n held this exact
 * seat is a same-seat event and its neighbour fields are not consulted there,
 * so it contributes nothing here either.
 */
function neighbourDelta(
  ctx: ScoringContext,
  nId: string,
  nRoomId: string,
  nSeatId: string,
  side: 'left' | 'right',
  oldId: string,
  newId: string,
): number {
  if (oldId === newId) return 0;
  const w = ctx.weights;
  let delta = 0;

  const history = ctx.hist.byStudent.get(nId);
  if (history) {
    const weight = side === 'left' ? w.sameLeftNeighbour : w.sameRightNeighbour;
    for (const item of history) {
      if (item.a.roomId === nRoomId && item.a.seatId === nSeatId) continue;
      const prev = side === 'left' ? item.a.leftNeighbourId : item.a.rightNeighbourId;
      if (!prev) continue;
      const d = decay(item.d);
      if (prev === oldId) delta -= weight * d;
      if (prev === newId) delta += weight * d;
    }
  }

  const deptN = ctx.deptOf.get(nId);
  if (deptN && ctx.mode === 'MIXED') {
    if (ctx.deptOf.get(oldId) === deptN) delta -= w.sameDeptAdjacent;
    if (ctx.deptOf.get(newId) === deptN) delta += w.sameDeptAdjacent;
  }

  const rollN = ctx.rollMeta.get(nId) ?? null;
  if (rollN) {
    if (consecutiveRolls(rollN, ctx.rollMeta.get(oldId) ?? null)) delta -= w.sequentialRoll;
    if (consecutiveRolls(rollN, ctx.rollMeta.get(newId) ?? null)) delta += w.sequentialRoll;
  }

  return delta;
}

/**
 * True penalty delta of swapping two seated students.
 *
 * - The two students' own penalties are re-evaluated at each other's seats.
 * - The students sitting next to their seats see a new neighbour; their
 *   neighbour-dependent terms are delta-adjusted per affected side.
 *
 * Everything else (room fill, imbalance, everyone else's seat/history terms)
 * is unchanged by a swap, so this is exact — and still O(H): no allocation of
 * the full arrangement, no full rescore. Callers that cache each student's
 * current penalty may pass it as `beforeTotal` to skip the two lookups.
 */
export function swapDelta(ctx: ScoringContext, a: Assignment, b: Assignment, beforeTotal?: number): number {
  const kA = seatKey(a.roomId, a.seatId);
  const kB = seatKey(b.roomId, b.seatId);
  const before =
    beforeTotal !== undefined
      ? beforeTotal
      : penaltyAt(ctx, a.studentId, a.roomId, a.seatId, a.benchNo) +
        penaltyAt(ctx, b.studentId, b.roomId, b.seatId, b.benchNo);
  const ov: OccupantOverride = { k1: kA, v1: b.studentId, k2: kB, v2: a.studentId };
  const after =
    penaltyAt(ctx, a.studentId, b.roomId, b.seatId, b.benchNo, ov) +
    penaltyAt(ctx, b.studentId, a.roomId, a.seatId, a.benchNo, ov);

  let delta = after - before;
  delta += swappedSeatSideDelta(ctx, kA, a.studentId, b.studentId, kB);
  delta += swappedSeatSideDelta(ctx, kB, b.studentId, a.studentId, kA);
  return delta;
}

/** Externality: students adjacent to `seatK` get a new neighbour across the swap. */
function swappedSeatSideDelta(
  ctx: ScoringContext,
  seatK: string,
  oldId: string,
  newId: string,
  otherSeatK: string,
): number {
  let delta = 0;
  const leftK = ctx.leftSeat.get(seatK) ?? null;
  const rightK = ctx.rightSeat.get(seatK) ?? null;

  if (leftK && leftK !== otherSeatK) {
    const nId = ctx.occupant.get(leftK);
    // seatK sits on n's right-hand side.
    if (nId && nId !== oldId && nId !== newId) {
      const n = ctx.assigned.get(nId);
      if (n) delta += neighbourDelta(ctx, nId, n.roomId, n.seatId, 'right', oldId, newId);
    }
  }
  if (rightK && rightK !== otherSeatK) {
    const nId = ctx.occupant.get(rightK);
    // seatK sits on n's left-hand side.
    if (nId && nId !== oldId && nId !== newId) {
      const n = ctx.assigned.get(nId);
      if (n) delta += neighbourDelta(ctx, nId, n.roomId, n.seatId, 'left', oldId, newId);
    }
  }
  return delta;
}

export function applySwap(ctx: ScoringContext, a: Assignment, b: Assignment): void {
  removeStudent(ctx, a.studentId);
  removeStudent(ctx, b.studentId);
  place(ctx, { ...a, roomId: b.roomId, seatId: b.seatId, benchNo: b.benchNo });
  place(ctx, { ...b, roomId: a.roomId, seatId: a.seatId, benchNo: a.benchNo });
}

/** λ · variance(fill%) · 100 — soft room utilisation balance (Section 4.4). */
function imbalanceTerm(ctx: ScoringContext): number {
  const fills: number[] = [];
  for (const [roomId, size] of ctx.roomSize) {
    if (size > 0) fills.push((ctx.roomUsed.get(roomId) ?? 0) / size);
  }
  if (fills.length === 0) return 0;
  const mean = fills.reduce((s, x) => s + x, 0) / fills.length;
  const variance = fills.reduce((s, x) => s + (x - mean) ** 2, 0) / fills.length;
  return ctx.weights.imbalance * variance * 100;
}

/** Occupied adjacent-bench pairs whose students sit in the same department. */
function sameDeptAdjacentPairs(ctx: ScoringContext): number {
  let count = 0;
  for (const [, studentId] of ctx.occupant) {
    const a = ctx.assigned.get(studentId);
    if (!a) continue;
    const rightKey = ctx.rightSeat.get(seatKey(a.roomId, a.seatId)) ?? null;
    if (!rightKey) continue;
    const other = ctx.occupant.get(rightKey);
    if (!other) continue;
    const myDept = ctx.deptOf.get(studentId);
    if (myDept && ctx.deptOf.get(other) === myDept) count++;
  }
  return count;
}

export type ScoredSolution = {
  penalty: number;
  breakdown: Breakdown;
  stats: Omit<Stats, 'timeMs' | 'iterations'>;
};

/**
 * Counts reported by the admin UI: how many students repeat an event **against
 * the most recent previous paper only** (d = 1), plus how many adjacent bench
 * pairs in the final arrangement hold the same department.
 */
function statsAgainstPrevious(ctx: ScoringContext): Omit<Stats, 'timeMs' | 'iterations'> {
  let sameSeatAsPrev = 0;
  let sameRoomAsPrev = 0;
  let sameBenchNoAsPrev = 0;
  let sameNeighbourAsPrev = 0;

  for (const [studentId, a] of ctx.assigned) {
    const history = ctx.hist.byStudent.get(studentId);
    const prev = history ? history.find((x) => x.d === 1) : undefined;
    if (!prev) continue;
    const p = prev.a;
    if (p.roomId === a.roomId && p.seatId === a.seatId) {
      sameSeatAsPrev++;
      continue;
    }
    if (p.roomId === a.roomId) sameRoomAsPrev++;
    if (p.benchNo === a.benchNo) sameBenchNoAsPrev++;
    const [leftId, rightId] = neighboursOf(ctx, seatKey(a.roomId, a.seatId));
    const leftRepeat = Boolean(leftId && p.leftNeighbourId && leftId === p.leftNeighbourId);
    const rightRepeat = Boolean(rightId && p.rightNeighbourId && rightId === p.rightNeighbourId);
    if (leftRepeat || rightRepeat) sameNeighbourAsPrev++;
  }

  return {
    sameSeatAsPrev,
    sameRoomAsPrev,
    sameBenchNoAsPrev,
    sameNeighbourAsPrev,
    sameDeptAdjacent: sameDeptAdjacentPairs(ctx),
  };
}

/**
 * Full score of the current arrangement. Recomputes every student's penalty
 * (O(N·H)) — used after construction and after the local-search loop, never
 * inside it.
 */
export function scoreSolution(ctx: ScoringContext): ScoredSolution {
  const breakdown = zeroBreakdown();
  let penalty = 0;

  for (const [studentId, a] of ctx.assigned) {
    penalty += penaltyAt(ctx, studentId, a.roomId, a.seatId, a.benchNo, undefined, breakdown);
  }

  breakdown.imbalance = imbalanceTerm(ctx);
  penalty += breakdown.imbalance;

  return { penalty, breakdown, stats: statsAgainstPrevious(ctx) };
}
