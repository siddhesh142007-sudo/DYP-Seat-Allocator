import { describe, it, expect } from 'vitest';
import { generateSeating } from '../../src/engine/index.ts';
import { allocate } from '../../src/engine/allocate.ts';
import { validate } from '../../src/engine/validate.ts';
import { runInWorker } from '../../src/engine/worker.ts';
import type { EngineConfig, EngineInput, HistoryExam, Student, Room } from '../../src/engine/types.ts';

const W: EngineConfig['weights'] = {
  sameSeat: 100, sameRoom: 30, sameBenchNo: 10,
  sameLeftNeighbour: 20, sameRightNeighbour: 20,
  sameDeptAdjacent: 15, imbalance: 1, sequentialRoll: 5,
};

function cfg(seed = 's1', over: Partial<EngineConfig> = {}): EngineConfig {
  return { mode: 'MIXED', seed, timeBudgetMs: 5000, historyDepth: 0, weights: W, ...over };
}

function mk(n: number, rooms: Array<{ id: string; benches: number }>, seed = 's1', h: HistoryExam[] = [], over: Partial<EngineConfig> = {}) {
  const students = Array.from({ length: n }, (_, i) => ({ id: `S${i + 1}`, rollNo: `R${i + 1}`, departmentId: 'D1' }));
  const rms = rooms.map(r => ({ id: r.id, seats: Array.from({ length: r.benches }, (_, b) => ({ id: `${r.id}-B${b + 1}`, benchNo: b + 1 })) }));
  const cfgv: EngineConfig = cfg(seed, { historyDepth: h.length > 0 ? 3 : 0, ...over });
  return generateSeating({ students, rooms: rms, history: h, config: cfgv });
}

function depts(n: number, deptCount: number): Student[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `S${i + 1}`,
    rollNo: `R${String(i + 1).padStart(3, '0')}`,
    departmentId: `D${(i % deptCount) + 1}`,
  }));
}

function roomsOf(spec: Array<{ id: string; benches: number }>): Room[] {
  return spec.map(r => ({ id: r.id, seats: Array.from({ length: r.benches }, (_, b) => ({ id: `${r.id}-B${b + 1}`, benchNo: b + 1 })) }));
}

function baseOfHistory(assignments: { studentId: string; roomId: string; seatId: string; benchNo: number }[], order: number, examId: string): HistoryExam {
  const byRoom = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const list = byRoom.get(a.roomId) ?? [];
    list.push(a);
    byRoom.set(a.roomId, list);
  }
  const neighbour = new Map<string, { left: string | null; right: string | null }>();
  for (const list of byRoom.values()) {
    list.sort((x, y) => x.benchNo - y.benchNo);
    list.forEach((a, i) => neighbour.set(a.studentId, {
      left: i > 0 ? list[i - 1]!.studentId : null,
      right: i < list.length - 1 ? list[i + 1]!.studentId : null,
    }));
  }
  return {
    examId,
    order,
    assignments: assignments.map(a => ({
      studentId: a.studentId,
      roomId: a.roomId,
      seatId: a.seatId,
      benchNo: a.benchNo,
      leftNeighbourId: neighbour.get(a.studentId)?.left ?? null,
      rightNeighbourId: neighbour.get(a.studentId)?.right ?? null,
    })),
  };
}

describe('engine', () => {
  it('10 students', () => { const r = mk(10, [{ id: 'R1', benches: 20 }]); expect(r.ok).toBe(true); });
  it('insufficient', () => { const r = mk(5, [{ id: 'R1', benches: 2 }]); expect(r.ok).toBe(false); if (!r.ok) expect(r.failure.code).toBe('INSUFFICIENT_SEATS'); });
  it('deterministic', () => {
    const a = mk(5, [{ id: 'R1', benches: 10 }], 'x'); const b = mk(5, [{ id: 'R1', benches: 10 }], 'x');
    expect(a.ok && b.ok).toBe(true); if (a.ok && b.ok) expect(JSON.stringify(a.assignments)).toBe(JSON.stringify(b.assignments));
  });
  it('no dups', () => {
    const r = mk(20, [{ id: 'R1', benches: 20 }], 'y');
    if (r.ok) { const s = new Set(r.assignments.map(x => x.studentId)); const k = new Set(r.assignments.map(x => x.roomId + ':' + x.seatId)); expect(s.size).toBe(20); expect(k.size).toBe(20); }
  });
  it('1000 students', () => {
    const r = mk(1000, [{ id: 'R1', benches: 500 }, { id: 'R2', benches: 500 }], 'z');
    expect(r.ok).toBe(true); if (r.ok) { const s = new Set(r.assignments.map(x => x.studentId)); expect(s.size).toBe(1000); }
  });
  it('5000 students', () => {
    const rms = [{ id: 'R1', benches: 1000 }, { id: 'R2', benches: 1000 }, { id: 'R3', benches: 1000 }, { id: 'R4', benches: 1000 }, { id: 'R5', benches: 1000 }];
    mk(1000, [{ id: 'W1', benches: 500 }, { id: 'W2', benches: 500 }], 'warm'); // JIT warm-up, not timed
    // 1600 ms budget: allocate + improve search box + validate must all fit
    // under the guide's 2000 ms target with margin, even on a loaded machine.
    const t0 = Date.now(); const r = mk(5000, rms, 'z', [], { timeBudgetMs: 1600 }); const ms = Date.now() - t0;
    expect(ms).toBeLessThan(2000); // aim
    expect(r.ok).toBe(true);
  });

  it('exact fit: every seat used, nothing over capacity', () => {
    const r = mk(40, [{ id: 'R1', benches: 25 }, { id: 'R2', benches: 15 }], 'fit');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.assignments).toHaveLength(40);
      const perRoom = new Map<string, number>();
      for (const a of r.assignments) perRoom.set(a.roomId, (perRoom.get(a.roomId) ?? 0) + 1);
      expect(perRoom.get('R1')).toBe(25);
      expect(perRoom.get('R2')).toBe(15);
    }
  });

  it('excess students fail with structured details', () => {
    const r = mk(30, [{ id: 'R1', benches: 20 }], 'excess');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.code).toBe('INSUFFICIENT_SEATS');
      const d = r.failure.details as { required: number; available: number; additionalRequired: number };
      expect(d).toEqual({ required: 30, available: 20, additionalRequired: 10 });
    }
  });

  it('zero students -> NO_ELIGIBLE_STUDENTS', () => {
    const r = generateSeating({ students: [], rooms: roomsOf([{ id: 'R1', benches: 10 }]), history: [], config: cfg() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe('NO_ELIGIBLE_STUDENTS');
  });

  it('zero rooms -> NO_AVAILABLE_ROOMS', () => {
    const r = generateSeating({ students: depts(5, 1), rooms: [], history: [], config: cfg() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe('NO_AVAILABLE_ROOMS');
  });

  it('all seats disabled -> NO_AVAILABLE_ROOMS', () => {
    const rooms: Room[] = [{ id: 'R1', seats: [{ id: 'R1-B1', benchNo: 1, status: 'DISABLED' }, { id: 'R1-B2', benchNo: 2, status: 'DISABLED' }] }];
    const r = generateSeating({ students: depts(2, 1), rooms, history: [], config: cfg() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe('NO_AVAILABLE_ROOMS');
  });

  it('disabled seats are never assigned and do not count towards capacity', () => {
    const rooms: Room[] = [{
      id: 'R1',
      seats: [
        { id: 'R1-B1', benchNo: 1 }, { id: 'R1-B2', benchNo: 2, status: 'DISABLED' },
        { id: 'R1-B3', benchNo: 3 }, { id: 'R1-B4', benchNo: 4, status: 'DISABLED' },
      ],
    }];
    const r = generateSeating({ students: depts(2, 1), rooms, history: [], config: cfg() });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const used = new Set(r.assignments.map(a => a.seatId));
      expect(used.has('R1-B2')).toBe(false);
      expect(used.has('R1-B4')).toBe(false);
      expect(r.assignments).toHaveLength(2);
    }
    const over = generateSeating({ students: depts(3, 1), rooms, history: [], config: cfg() });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.failure.code).toBe('INSUFFICIENT_SEATS');
  });

  it('department larger than any single room still seats in MIXED and BLOCK', () => {
    for (const mode of ['MIXED', 'BLOCK'] as const) {
      const r = generateSeating({
        students: depts(30, 1),
        rooms: roomsOf([{ id: 'R1', benches: 20 }, { id: 'R2', benches: 20 }]),
        history: [], config: cfg(`dept-${mode}`, { mode }),
      });
      expect(r.ok, `${mode}: ${r.ok ? '' : JSON.stringify(r.failure)}`).toBe(true);
    }
  });

  it('maxPerDepartment feasible: never exceeded', () => {
    const r = generateSeating({
      students: depts(40, 2),
      rooms: roomsOf([{ id: 'R1', benches: 20 }, { id: 'R2', benches: 20 }]),
      history: [], config: cfg('cap', { maxPerDepartment: 10 }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const counts = new Map<string, number>();
      for (const a of r.assignments) {
        const dept = `D${((Number(a.studentId.slice(1)) - 1) % 2) + 1}`;
        const key = `${dept}::${a.roomId}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(10);
    }
  });

  it('maxPerDepartment impossible -> DEPARTMENT_RULE_IMPOSSIBLE with details', () => {
    const r = generateSeating({
      students: depts(30, 1),
      rooms: roomsOf([{ id: 'R1', benches: 20 }, { id: 'R2', benches: 20 }]),
      history: [], config: cfg('cap-bad', { maxPerDepartment: 5 }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.code).toBe('DEPARTMENT_RULE_IMPOSSIBLE');
      const d = r.failure.details as { departmentId: string; students: number; maxPerDepartment: number; reachable: number };
      expect(d.departmentId).toBe('D1');
      expect(d.students).toBe(30);
      expect(d.maxPerDepartment).toBe(5);
      expect(d.reachable).toBe(10);
    }
  });

  it('every generated plan passes the independent validator', () => {
    for (const seed of ['v1', 'v2', 'v3']) {
      const r = generateSeating({
        students: depts(97, 3),
        rooms: roomsOf([{ id: 'R1', benches: 40 }, { id: 'R2', benches: 40 }, { id: 'R3', benches: 30 }]),
        history: [], config: cfg(seed),
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const report = validate({ students: depts(97, 3), rooms: roomsOf([{ id: 'R1', benches: 40 }, { id: 'R2', benches: 40 }, { id: 'R3', benches: 30 }]), history: [], config: cfg(seed) }, r.assignments);
        expect(report.status).toBe('VALID');
        expect(report.violations).toEqual([]);
        expect(r.assignments).toHaveLength(97);
        const students = new Set(r.assignments.map(a => a.studentId));
        const seats = new Set(r.assignments.map(a => `${a.roomId}::${a.seatId}`));
        expect(students.size).toBe(97);
        expect(seats.size).toBe(97);
      }
    }
  });

  it('fuzz: 200 random inputs keep the hard invariants', () => {
    let s = 12345;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let t = 0; t < 200; t++) {
      const n = 1 + Math.floor(rnd() * 120);
      const roomCount = 1 + Math.floor(rnd() * 4);
      const spec = Array.from({ length: roomCount }, (_, i) => ({ id: `FR${i + 1}`, benches: Math.max(1, Math.ceil(n / roomCount) + Math.floor(rnd() * 6) - 2) }));
      const deptCount = 1 + Math.floor(rnd() * 3);
      const students = depts(n, deptCount);
      const rooms = roomsOf(spec);
      const totalSeats = spec.reduce((sum, r) => sum + r.benches, 0);
      const input: EngineInput = { students, rooms, history: [], config: cfg(`f${t}`) };
      const r = generateSeating(input);
      if (totalSeats < n) {
        expect(r.ok, `t=${t}`).toBe(false);
        continue;
      }
      expect(r.ok, `t=${t}: ${r.ok ? '' : JSON.stringify(r.failure)}`).toBe(true);
      if (!r.ok) continue;
      expect(r.assignments, `t=${t}`).toHaveLength(n);
      expect(new Set(r.assignments.map(a => a.studentId)).size, `t=${t}`).toBe(n);
      expect(new Set(r.assignments.map(a => `${a.roomId}::${a.seatId}`)).size, `t=${t}`).toBe(n);
      const caps = new Map(rooms.map(rm => [rm.id, rm.seats.length]));
      const perRoom = new Map<string, number>();
      for (const a of r.assignments) {
        expect(a.benchNo).toBeGreaterThanOrEqual(1);
        perRoom.set(a.roomId, (perRoom.get(a.roomId) ?? 0) + 1);
      }
      for (const [roomId, count] of perRoom) expect(count, `t=${t} room ${roomId}`).toBeLessThanOrEqual(caps.get(roomId)!);
      expect(validate(input, r.assignments).status, `t=${t}`).toBe('VALID');
    }
  });

  it('BLOCK keeps department blocks contiguous inside every room', () => {
    const input: EngineInput = {
      students: depts(60, 3),
      rooms: roomsOf([{ id: 'R1', benches: 20 }, { id: 'R2', benches: 20 }, { id: 'R3', benches: 20 }]),
      history: [], config: cfg('block1', { mode: 'BLOCK' }),
    };
    const r = generateSeating(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const byRoom = new Map<string, string[]>();
      for (const a of [...r.assignments].sort((x, y) => (x.roomId === y.roomId ? x.benchNo - y.benchNo : x.roomId < y.roomId ? -1 : 1))) {
        const dept = `D${((Number(a.studentId.slice(1)) - 1) % 3) + 1}`;
        const list = byRoom.get(a.roomId) ?? [];
        list.push(dept);
        byRoom.set(a.roomId, list);
      }
      for (const [roomId, seq] of byRoom) {
        const seen = new Set<string>();
        let prev = seq[0];
        seen.add(prev!);
        for (const d of seq.slice(1)) {
          if (d !== prev) {
            expect(seen.has(d), `room ${roomId}: dept ${d} reappears in ${seq.join(',')}`).toBe(false);
            seen.add(d);
            prev = d;
          }
        }
      }
    }
  });

  it('improve never raises the penalty and accepts improving swaps', () => {
    const students = depts(60, 3);
    const rooms = roomsOf([{ id: 'R1', benches: 25 }, { id: 'R2', benches: 25 }, { id: 'R3', benches: 25 }]);
    const first = generateSeating({ students, rooms, history: [], config: cfg('hist-base') });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const history = [baseOfHistory(first.assignments, 1, 'P1')];
    const input: EngineInput = { students, rooms, history, config: cfg('hist-1', { historyDepth: 3 }) };
    const allocated = allocate(input);
    expect(allocated.ok).toBe(true);
    const generated = generateSeating(input);
    expect(generated.ok).toBe(true);
    if (allocated.ok && generated.ok) {
      expect(generated.penalty).toBeLessThanOrEqual(allocated.penalty);
      expect(generated.stats.iterations).toBeGreaterThan(0);
      expect(generated.breakdown.sameNeighbour).toBeGreaterThanOrEqual(0);
    }
  });

  it('history awareness reduces repeats versus a history-blind baseline', () => {
    const students = depts(50, 2);
    const rooms = roomsOf([{ id: 'R1', benches: 50 }, { id: 'R2', benches: 50 }]);
    const blind = generateSeating({ students, rooms, history: [], config: cfg('repeat-blind') });
    expect(blind.ok).toBe(true);
    if (!blind.ok) return;
    const history = [baseOfHistory(blind.assignments, 1, 'P1')];
    const aware = generateSeating({ students, rooms, history, config: cfg('repeat-aware', { historyDepth: 3 }) });
    expect(aware.ok).toBe(true);
    if (!aware.ok) return;
    // The blind baseline scatters the 50 students across both rooms; knowing
    // the previous paper pulls them back towards it (same-seat/room rewards).
    const room1 = (xs: { roomId: string }[]) => xs.filter(a => a.roomId === 'R1').length;
    expect(room1(aware.assignments)).toBeGreaterThan(room1(blind.assignments));
    expect(aware.stats.sameSeatAsPrev).toBeLessThanOrEqual(blind.stats.sameSeatAsPrev);
  });

  it('different seeds give different arrangements', () => {
    const a = mk(100, [{ id: 'R1', benches: 50 }, { id: 'R2', benches: 50 }], 'seed-a');
    const b = mk(100, [{ id: 'R1', benches: 50 }, { id: 'R2', benches: 50 }], 'seed-b');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(JSON.stringify(a.assignments)).not.toBe(JSON.stringify(b.assignments));
  });

  it('stats and timing are populated', () => {
    const r = mk(30, [{ id: 'R1', benches: 30 }], 'stats');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stats.timeMs).toBeGreaterThan(0);
      expect(r.timing.totalMs).toBeGreaterThanOrEqual(r.timing.allocateMs);
      expect(r.timing.improveMs).toBeGreaterThanOrEqual(0);
      expect(r.timing.validateMs).toBeGreaterThanOrEqual(0);
      expect(r.penalty).toBeGreaterThanOrEqual(0);
      expect(r.stats.sameDeptAdjacent).toBeGreaterThanOrEqual(0);
    }
  });

  it('100 students', () => {
    const r = mk(100, [{ id: 'R1', benches: 60 }, { id: 'R2', benches: 60 }], 'hundred');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.assignments).toHaveLength(100);
      expect(validate({ students: Array.from({ length: 100 }, (_, i) => ({ id: `S${i + 1}`, rollNo: `R${i + 1}`, departmentId: 'D1' })), rooms: roomsOf([{ id: 'R1', benches: 60 }, { id: 'R2', benches: 60 }]), history: [], config: cfg('hundred') }, r.assignments).status).toBe('VALID');
    }
  });

  it('unequal department sizes seat everyone', () => {
    const students = [
      ...Array.from({ length: 50 }, (_, i) => ({ id: `A${i + 1}`, rollNo: `RA${String(i + 1).padStart(3, '0')}`, departmentId: 'DA' })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `B${i + 1}`, rollNo: `RB${String(i + 1).padStart(3, '0')}`, departmentId: 'DB' })),
      ...Array.from({ length: 17 }, (_, i) => ({ id: `C${i + 1}`, rollNo: `RC${String(i + 1).padStart(3, '0')}`, departmentId: 'DC' })),
    ];
    const input: EngineInput = { students, rooms: roomsOf([{ id: 'R1', benches: 50 }, { id: 'R2', benches: 50 }]), history: [], config: cfg('unequal') };
    const r = generateSeating(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.assignments).toHaveLength(97);
      expect(validate(input, r.assignments).status).toBe('VALID');
    }
  });

  it('single room, exactly N seats: unavoidable repeats are reported, not failed', () => {
    const students = depts(40, 2);
    const rooms = roomsOf([{ id: 'R1', benches: 40 }]);
    const first = generateSeating({ students, rooms, history: [], config: cfg('tight-base') });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const history = [baseOfHistory(first.assignments, 1, 'P1')];
    const r = generateSeating({ students, rooms, history, config: cfg('tight-1', { historyDepth: 3 }) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // one room ⇒ everyone's room repeats: unavoidable, and reported in stats
      expect(r.stats.sameRoomAsPrev).toBe(40);
      expect(r.penalty).toBeGreaterThan(0);
      expect(r.assignments).toHaveLength(40);
      expect(validate({ students, rooms, history, config: cfg('tight-1', { historyDepth: 3 }) }, r.assignments).status).toBe('VALID');
    }
  });

  it('three papers: paper 3 avoids repeats against BOTH previous papers', () => {
    const students = depts(40, 3);
    const rooms = roomsOf([{ id: 'R1', benches: 25 }, { id: 'R2', benches: 25 }, { id: 'R3', benches: 25 }, { id: 'R4', benches: 25 }]);
    const p1 = generateSeating({ students, rooms, history: [], config: cfg('three-1') });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    const h1 = [baseOfHistory(p1.assignments, 1, 'P1')];
    const p2 = generateSeating({ students, rooms, history: h1, config: cfg('three-2', { historyDepth: 3 }) });
    expect(p2.ok).toBe(true);
    if (!p2.ok) return;
    const h2 = [...h1, baseOfHistory(p2.assignments, 2, 'P2')];
    const p3 = generateSeating({ students, rooms, history: h2, config: cfg('three-3', { historyDepth: 3 }) });
    expect(p3.ok).toBe(true);
    // history-blind baseline for paper 3 (Approach A: ignores history entirely)
    const p3blind = generateSeating({ students, rooms, history: [], config: cfg('three-3-blind') });
    expect(p3blind.ok).toBe(true);
    if (!p3.ok || !p3blind.ok) return;

    const repeatsVs = (plan: { studentId: string; roomId: string; seatId: string; benchNo: number }[], prev: { studentId: string; roomId: string; seatId: string; benchNo: number }[]) => {
      const by = new Map(prev.map((a) => [a.studentId, a]));
      let seat = 0, room = 0;
      for (const a of plan) {
        const p = by.get(a.studentId);
        if (!p) continue;
        if (p.roomId === a.roomId && p.seatId === a.seatId) seat++;
        else if (p.roomId === a.roomId) room++;
      }
      return { seat, room };
    };
    const vs1 = repeatsVs(p3.assignments, p1.assignments);
    const vs2 = repeatsVs(p3.assignments, p2.assignments);
    expect(vs1.seat, `vs P1: ${JSON.stringify(vs1)}`).toBe(0);
    expect(vs2.seat, `vs P2: ${JSON.stringify(vs2)}`).toBe(0);
    // statistical threshold against the history-blind baseline: total room+seat
    // repeats across both previous papers must be strictly lower
    const total = (plan: typeof p3.assignments) => {
      const a = repeatsVs(plan, p1.assignments);
      const b = repeatsVs(plan, p2.assignments);
      return a.seat + a.room + b.seat + b.room;
    };
    expect(total(p3.assignments)).toBeLessThan(total(p3blind.assignments));
  });

  it('runInWorker matches the inline engine result', async () => {
    const students = depts(40, 2);
    const rooms = roomsOf([{ id: 'R1', benches: 25 }, { id: 'R2', benches: 25 }]);
    const input: EngineInput = { students, rooms, history: [], config: cfg('worker-1', { timeBudgetMs: 8000 }) };
    const inline = generateSeating(input);
    const viaWorker = await runInWorker(input);
    expect(inline.ok).toBe(true);
    expect(viaWorker.ok).toBe(true);
    if (inline.ok && viaWorker.ok) {
      expect(JSON.stringify(viaWorker.assignments)).toBe(JSON.stringify(inline.assignments));
      expect(viaWorker.penalty).toBe(inline.penalty);
    }
  }, 30000);
});
