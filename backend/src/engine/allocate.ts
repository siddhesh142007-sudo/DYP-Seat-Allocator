import { makePrng, fisherYates } from './prng.js';
import type { Assignment, EngineInput, EngineResult, Room, Student } from './types.js';
import { buildContext, compareRollNumbers, place, penaltyAt, seatKey, scoreSolution } from './scoring.js';

type FreeSeat = { key: string; roomId: string; seatId: string; benchNo: number };

/** Swap-removable array of free seats with O(1) lookup by seat key. */
type Pool = { arr: FreeSeat[]; pos: Map<string, number> };

function newPool(seats: FreeSeat[]): Pool {
  const pos = new Map<string, number>();
  seats.forEach((s, i) => pos.set(s.key, i));
  return { arr: seats, pos };
}

function poolRemove(p: Pool, key: string): void {
  const i = p.pos.get(key);
  if (i === undefined) return;
  const last = p.arr[p.arr.length - 1]!;
  p.arr.pop();
  p.pos.delete(key);
  if (i < p.arr.length) {
    p.arr[i] = last;
    p.pos.set(last.key, i);
  }
}

/** Sample up to k distinct seats uniformly (O(k) expected, no full shuffle). */
function sampleFrom(pool: Pool, k: number, rng: () => number): FreeSeat[] {
  const n = pool.arr.length;
  if (n <= k) return pool.arr.slice();
  const picked = new Map<number, FreeSeat>();
  for (let t = 0; t < k * 4 + 8 && picked.size < k; t++) {
    const idx = Math.floor(rng() * n);
    if (!picked.has(idx)) picked.set(idx, pool.arr[idx]!);
  }
  return [...picked.values()];
}

function byStudentId(a: Assignment, b: Assignment): number {
  return a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0;
}

function enabledCount(room: Room): number {
  let n = 0;
  for (const s of room.seats) if (s.status !== 'DISABLED') n++;
  return n;
}

function insufficient(students: number, available: number): EngineResult {
  return {
    ok: false,
    failure: {
      code: 'INSUFFICIENT_SEATS',
      message: `Not enough seats: ${students} students need seats but only ${available} are available.`,
      details: { required: students, available, additionalRequired: Math.max(0, students - available) },
    },
  };
}

/**
 * Seeded randomized constraint-aware greedy construction (guide §4.3 steps 2–4).
 *
 * - Rooms are shuffled, biased towards rooms with little recent history, then
 *   only the smallest sufficient prefix is used (balanced utilisation without
 *   opening rooms nobody needs).
 * - Students are placed hardest-first (most history entries first) and each
 *   chooses the lowest-penalty seat among K sampled free seats. The candidate
 *   score also carries the O(1) marginal imbalance term so rooms fill evenly.
 * - BLOCK mode pre-claims a contiguous run of benches per department (respecting
 *   maxPerDepartment) and each student picks inside its own department's block.
 * - MIXED mode samples from the global free pool and honours maxPerDepartment
 *   by preferring compliant seats (scanning the whole pool before giving up).
 *
 * Pure: no DB, no HTTP, no framework. Deterministic for a given seed.
 */
export function allocate(input: EngineInput): EngineResult {
  const t0 = Date.now();
  const seedVal = input.config.seed ?? Date.now();
  const seed = String(seedVal);
  const rng = makePrng(seedVal);
  const cap = input.config.maxPerDepartment ?? null;
  const k = input.config.kCandidates ?? 16;
  const mode = input.config.mode;
  const weights = input.config.weights;
  const n = input.students.length;

  // --- room selection: shuffle -> low recent usage first -> fewest rooms -----
  const usable = input.rooms.filter((r) => enabledCount(r) > 0);
  const usage = new Map<string, number>();
  for (const h of input.history) {
    for (const a of h.assignments) usage.set(a.roomId, (usage.get(a.roomId) ?? 0) + 1);
  }
  const sizes = new Map(usable.map((r) => [r.id, enabledCount(r)]));
  const ordered = fisherYates(usable, rng).sort(
    (a, b) => (usage.get(a.id) ?? 0) - (usage.get(b.id) ?? 0) || (sizes.get(b.id) ?? 0) - (sizes.get(a.id) ?? 0),
  );
  const selected: Room[] = [];
  let capacity = 0;
  for (const r of ordered) {
    if (capacity >= n) break;
    selected.push(r);
    capacity += sizes.get(r.id) ?? 0;
  }
  if (capacity < n) return insufficient(n, capacity);

  const selectedRooms: Room[] = selected.map((r) => ({
    ...r,
    seats: r.seats.filter((s) => s.status !== 'DISABLED'),
  }));
  const ctx = buildContext({ ...input, rooms: selectedRooms });

  const freeSeats: FreeSeat[] = [];
  for (const r of selectedRooms) {
    for (const s of r.seats) freeSeats.push({ key: seatKey(r.id, s.id), roomId: r.id, seatId: s.id, benchNo: s.benchNo });
  }
  const free = newPool(freeSeats);
  if (free.arr.length < n) return insufficient(n, free.arr.length);

  // --- O(1) marginal imbalance: λ · Δvariance(fill%) · 100 -------------------
  const roomCount = selectedRooms.length;
  let fillSum = 0;
  let fillSq = 0;
  const balanceDelta = (roomId: string): number => {
    if (roomCount === 0 || weights.imbalance === 0) return 0;
    const size = ctx.roomSize.get(roomId) ?? 0;
    if (size === 0) return 0;
    const used = ctx.roomUsed.get(roomId) ?? 0;
    const of = used / size;
    const nf = (used + 1) / size;
    const nSum = fillSum + (nf - of);
    const nSq = fillSq + nf * nf - of * of;
    const nVar = nSq / roomCount - (nSum / roomCount) ** 2;
    const oVar = fillSq / roomCount - (fillSum / roomCount) ** 2;
    return weights.imbalance * (nVar - oVar) * 100;
  };
  const commitFill = (roomId: string): void => {
    const size = ctx.roomSize.get(roomId) ?? 0;
    if (size === 0) return;
    const nf = (ctx.roomUsed.get(roomId) ?? 0) / size;
    fillSum += nf;
    fillSq += nf * nf;
  };

  const scoreSeat = (st: Student, s: FreeSeat): number =>
    penaltyAt(ctx, st.id, s.roomId, s.seatId, s.benchNo) + balanceDelta(s.roomId);

  const compliant = (st: Student, s: FreeSeat): boolean =>
    cap == null || (ctx.deptRoomCount.get(`${st.departmentId}::${s.roomId}`) ?? 0) < cap;

  const bestOf = (st: Student, cand: FreeSeat[], pool: Pool | null): FreeSeat | null => {
    let best: FreeSeat | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const s of cand) {
      const v = scoreSeat(st, s);
      if (v < bestScore) {
        bestScore = v;
        best = s;
      }
    }
    if (best || pool == null) return best;
    for (const s of pool.arr) {
      const v = scoreSeat(st, s);
      if (v < bestScore) {
        bestScore = v;
        best = s;
      }
    }
    return best;
  };

  /** Choose the lowest-scoring seat, preferring maxPerDepartment-compliant ones. */
  const chooseSeat = (st: Student, pool: Pool): FreeSeat | null => {
    const cand = sampleFrom(pool, k, rng);
    if (cand.length === 0) return null;
    if (cap == null) return bestOf(st, cand, null);
    let best: FreeSeat | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const s of cand) {
      if (!compliant(st, s)) continue;
      const v = scoreSeat(st, s);
      if (v < bestScore) {
        bestScore = v;
        best = s;
      }
    }
    if (best) return best;
    // No compliant seat in the sample: scan the pool before giving up on the cap.
    for (const s of pool.arr) {
      if (!compliant(st, s)) continue;
      const v = scoreSeat(st, s);
      if (v < bestScore) {
        bestScore = v;
        best = s;
      }
    }
    return best ?? bestOf(st, cand, null);
  };

  // --- BLOCK mode: contiguous bench run per department -----------------------
  const deptPools = new Map<string, Pool>();
  const ownerOf = new Map<string, string>();
  if (mode === 'BLOCK') {
    const counts = new Map<string, number>();
    for (const s of input.students) counts.set(s.departmentId, (counts.get(s.departmentId) ?? 0) + 1);
    const depts = fisherYates([...counts.keys()], rng).sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
    const cursor = new Map<string, number>(selectedRooms.map((r) => [r.id, 0]));
    let startIdx = 0;
    for (const dept of depts) {
      let need = counts.get(dept) ?? 0;
      const claimed: FreeSeat[] = [];
      let i = startIdx;
      while (need > 0 && i < selectedRooms.length) {
        const room = selectedRooms[i]!;
        const at = cursor.get(room.id) ?? 0;
        const freeInRoom = room.seats.length - at;
        if (freeInRoom <= 0) {
          i++;
          continue;
        }
        const take = cap != null ? Math.min(need, freeInRoom, cap) : Math.min(need, freeInRoom);
        for (let j = 0; j < take; j++) {
          const s = room.seats[at + j]!;
          claimed.push({ key: seatKey(room.id, s.id), roomId: room.id, seatId: s.id, benchNo: s.benchNo });
        }
        cursor.set(room.id, at + take);
        need -= take;
        if (need > 0) i++;
      }
      deptPools.set(dept, newPool(claimed));
      for (const c of claimed) ownerOf.set(c.key, dept);
      // The next department resumes at the earliest room that still has free seats.
      while (
        startIdx < selectedRooms.length &&
        (cursor.get(selectedRooms[startIdx]!.id) ?? 0) >= selectedRooms[startIdx]!.seats.length
      ) {
        startIdx++;
      }
      // `need > 0` here would mean not enough seats, which feasibility()
      // already ruled out; those students would spill into the global pool.
    }
  }

  // --- greedy placement, hardest history first -------------------------------
  const students = fisherYates(input.students, rng).sort(
    (a, b) =>
      (ctx.hist.byStudent.get(b.id)?.length ?? 0) - (ctx.hist.byStudent.get(a.id)?.length ?? 0),
  );

  for (const st of students) {
    const deptPool = mode === 'BLOCK' ? deptPools.get(st.departmentId) : undefined;
    let pick: FreeSeat | null = null;
    if (deptPool) pick = chooseSeat(st, deptPool);
    if (!pick) pick = chooseSeat(st, free);
    if (!pick) return insufficient(n - ctx.assigned.size, free.arr.length);

    const a: Assignment = { studentId: st.id, roomId: pick.roomId, seatId: pick.seatId, benchNo: pick.benchNo };
    place(ctx, a);
    poolRemove(free, pick.key);
    if (deptPool && deptPool !== free) poolRemove(deptPool, pick.key);
    const owner = ownerOf.get(pick.key);
    if (owner && owner !== st.departmentId) {
      const op = deptPools.get(owner);
      if (op) poolRemove(op, pick.key);
    }
    commitFill(pick.roomId);
  }

  const scored = scoreSolution(ctx);
  const t1 = Date.now();
  return {
    ok: true,
    assignments: [...ctx.assigned.values()].sort(byStudentId),
    penalty: scored.penalty,
    breakdown: scored.breakdown,
    stats: { ...scored.stats, timeMs: t1 - t0, iterations: 0 },
    seed,
    timing: { totalMs: t1 - t0, allocateMs: t1 - t0, improveMs: 0, validateMs: 0 },
  };
}

/**
 * Deterministic roll-order seating (config.strictRollOrder).
 *
 * Students ascend by roll number and fill each room's benches in bench order.
 * No sampling, no department grouping, no local search - any swap or
 * candidate choice would break the ordering the administrator asked for.
 * Penalties are still computed so the caller can see what ordering costs
 * compared with a shuffled plan.
 */
export function allocateStrictRollOrder(input: EngineInput): EngineResult {
  const t0 = Date.now();
  const seed = String(input.config.seed ?? 'roll-order');

  const usable = input.rooms.filter((r) => enabledCount(r) > 0);
  // Rooms in a stable order (the caller's intent order), benches ascending.
  const seatsInOrder: FreeSeat[] = [];
  for (const room of usable) {
    const seats = room.seats
      .filter((s) => s.status !== 'DISABLED')
      .sort((a, b) => a.benchNo - b.benchNo)
      .map((s) => ({ key: seatKey(room.id, s.id), roomId: room.id, seatId: s.id, benchNo: s.benchNo }));
    seatsInOrder.push(...seats);
  }

  // Numeric-aware: a string sort would place "…_100" before "…_9".
  const students = [...input.students].sort((a, b) => {
    const byRoll = compareRollNumbers(a.rollNo, b.rollNo);
    return byRoll !== 0 ? byRoll : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  if (seatsInOrder.length < students.length) return insufficient(students.length, seatsInOrder.length);

  const assignments: Assignment[] = students.map((st, i) => {
    const seat = seatsInOrder[i]!;
    return { studentId: st.id, roomId: seat.roomId, seatId: seat.seatId, benchNo: seat.benchNo };
  });

  const rooms = usable.map((r) => ({ ...r, seats: r.seats.filter((s) => s.status !== 'DISABLED') }));
  const ctx = buildContext({ ...input, rooms });
  for (const a of assignments) place(ctx, a);
  const scored = scoreSolution(ctx);

  const t1 = Date.now();
  return {
    ok: true,
    assignments: [...assignments].sort(byStudentId),
    penalty: scored.penalty,
    breakdown: scored.breakdown,
    stats: { ...scored.stats, timeMs: t1 - t0, iterations: 0 },
    seed,
    timing: { totalMs: t1 - t0, allocateMs: t1 - t0, improveMs: 0, validateMs: 0 },
  };
}
