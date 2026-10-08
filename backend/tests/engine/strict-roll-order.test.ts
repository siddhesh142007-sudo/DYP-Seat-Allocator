import { describe, it, expect } from 'vitest';
import { generateSeating } from '../../src/engine/index.ts';
import type { EngineConfig, EngineInput, Student, Room } from '../../src/engine/types.ts';

const W: EngineConfig['weights'] = {
  sameSeat: 100, sameRoom: 30, sameBenchNo: 10,
  sameLeftNeighbour: 20, sameRightNeighbour: 20,
  sameDeptAdjacent: 15, imbalance: 1, sequentialRoll: 5,
};

function cfg(over: Partial<EngineConfig> = {}): EngineConfig {
  return { mode: 'MIXED', seed: 'strict', timeBudgetMs: 5000, historyDepth: 0, weights: W, strictRollOrder: true, ...over };
}

/** One room with `benches` benches, bench numbers 1..n. */
function room(id: string, benches: number): Room {
  return {
    id,
    seats: Array.from({ length: benches }, (_, b) => ({ id: `${id}-B${b + 1}`, benchNo: b + 1 })),
  };
}

/** DYPIT-style roll numbers so ordering is realistic (zero-padded serials). */
function cohort(n: number, prefix = 'SE-AIDS-C'): Student[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `S${i + 1}`,
    rollNo: `${prefix}_${String(i + 1).padStart(2, '0')}`,
    departmentId: 'D1',
  }));
}

function run(students: Student[], rooms: Room[], over: Partial<EngineConfig> = {}) {
  return generateSeating({ students, rooms, history: [], config: cfg(over) });
}

/** Assignments keyed by student id, for order assertions. */
function byStudent(assignments: { studentId: string; benchNo: number; roomId: string }[]) {
  return new Map(assignments.map((a) => [a.studentId, a]));
}

describe('strictRollOrder seating', () => {
  it('seats students in ascending roll order into ascending benches', () => {
    // Deliberately supply students out of order to prove the engine sorts them.
    const students = [...cohort(5)].reverse();
    const res = run(students, [room('R1', 5)]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const map = byStudent(res.assignments);
    // roll _01 -> bench 1, _02 -> bench 2, ... _05 -> bench 5
    expect(map.get('S1')!.benchNo).toBe(1);
    expect(map.get('S2')!.benchNo).toBe(2);
    expect(map.get('S3')!.benchNo).toBe(3);
    expect(map.get('S4')!.benchNo).toBe(4);
    expect(map.get('S5')!.benchNo).toBe(5);
  });

  it('orders numerically, not lexicographically, past serial 99', () => {
    const students: Student[] = [
      { id: 'A', rollNo: 'SE-CE-A_100', departmentId: 'D1' },
      { id: 'B', rollNo: 'SE-CE-A_9', departmentId: 'D1' },
      { id: 'C', rollNo: 'SE-CE-A_10', departmentId: 'D1' },
      { id: 'D', rollNo: 'SE-CE-A_99', departmentId: 'D1' },
    ];
    const res = run(students, [room('R1', 4)]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const map = byStudent(res.assignments);
    // 9 < 10 < 99 < 100 as numbers; a string sort would put "100" after "10"
    // but before "9".
    expect(map.get('B')!.benchNo).toBe(1);
    expect(map.get('C')!.benchNo).toBe(2);
    expect(map.get('D')!.benchNo).toBe(3);
    expect(map.get('A')!.benchNo).toBe(4);
  });

  it('is deterministic across repeated runs', () => {
    const students = cohort(8);
    const a = run(students, [room('R1', 8)]);
    const b = run(students, [room('R1', 8)]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.assignments).toEqual(b.assignments);
  });

  it('ignores the seed so ordering cannot vary between papers', () => {
    const students = cohort(6);
    const a = run(students, [room('R1', 6)], { seed: 'paper-1' });
    const b = run(students, [room('R1', 6)], { seed: 'paper-2' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(byStudent(a.assignments).get('S1')!.seatId).toBe(byStudent(b.assignments).get('S1')!.seatId);
  });

  it('fills a partly filled room from bench 1, leaving later benches empty', () => {
    const res = run(cohort(3), [room('R1', 10)]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.assignments.map((a) => a.benchNo).sort((x, y) => x - y)).toEqual([1, 2, 3]);
  });

  it('spills into a second room in bench order when the first is full', () => {
    const res = run(cohort(7), [room('R1', 5), room('R2', 5)]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const map = byStudent(res.assignments);
    expect(map.get('S5')!.roomId).toBe('R1');
    expect(map.get('S6')!.roomId).toBe('R2');
    expect(map.get('S6')!.benchNo).toBe(1);
  });

  it('skips disabled benches', () => {
    const r: Room = { ...room('R1', 5) };
    r.seats[1] = { ...r.seats[1]!, status: 'DISABLED' };
    const res = run(cohort(4), [r]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const map = byStudent(res.assignments);
    expect(map.get('S2')!.benchNo).toBe(3); // bench 2 was disabled
  });

  it('fails with INSUFFICIENT_SEATS when there are not enough benches', () => {
    const res = run(cohort(5), [room('R1', 3)]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure.code).toBe('INSUFFICIENT_SEATS');
    expect(res.failure.details).toMatchObject({ required: 5, available: 3, additionalRequired: 2 });
  });

  it('produces a VALID report so a plan is still never invalid', () => {
    const res = run(cohort(6), [room('R1', 6)]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stats.timeMs).toBeGreaterThanOrEqual(0);
    // No duplicate seat or student can be produced by a linear fill.
    expect(new Set(res.assignments.map((a) => a.seatId)).size).toBe(res.assignments.length);
    expect(new Set(res.assignments.map((a) => a.studentId)).size).toBe(res.assignments.length);
  });

  it('reports the penalty an ordered arrangement costs', () => {
    const res = run(cohort(5), [room('R1', 5)]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(typeof res.penalty).toBe('number');
    expect(res.penalty).toBeGreaterThanOrEqual(0);
  });

  it('does not run local search (iterations stay zero)', () => {
    const res = run(cohort(10), [room('R1', 10)]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stats.iterations).toBe(0);
  });

  it('keeps ordering when history is present', () => {
    // History would normally pull students away from their previous seats; the
    // administrator's explicit ordering takes precedence.
    const students = cohort(4);
    const first = run(students, [room('R1', 8)]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const history = [
      {
        examId: 'prev',
        order: 1,
        assignments: first.assignments.map((a) => ({
          studentId: a.studentId,
          roomId: a.roomId,
          seatId: a.seatId,
          benchNo: a.benchNo,
        })),
      },
    ];
    const input: EngineInput = { students, rooms: [room('R1', 8)], history, config: cfg({ historyDepth: 3 }) };
    const second = generateSeating(input);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const map = byStudent(second.assignments);
    expect(map.get('S1')!.benchNo).toBe(1);
    expect(map.get('S4')!.benchNo).toBe(4);
  });
});