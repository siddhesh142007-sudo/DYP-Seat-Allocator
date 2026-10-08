/**
 * Guide §4.6 / Phase 6 demo: 3 departments, 3 rooms x 20 benches, 60 students
 * (20 per department), 3 papers with history. Prints each paper as a room/bench
 * table, per-paper repeat statistics against the previous paper, and a
 * plain-English explanation of how history influenced the allocation.
 *
 * Run: npm run demo:algorithm   (from backend/)
 */
import { generateSeating } from '../backend/src/engine/index.js';
import type { EngineConfig, EngineInput, EngineResult, HistoryExam, Room, Student } from '../backend/src/engine/types.js';

const students: Student[] = Array.from({ length: 60 }, (_, i) => ({
  id: `S${String(i + 1).padStart(2, '0')}`,
  rollNo: `R${String(i + 1).padStart(3, '0')}`,
  departmentId: `D${((i % 3) + 1)}`,
}));

const rooms: Room[] = Array.from({ length: 3 }, (_, r) => ({
  id: `ROOM${r + 1}`,
  seats: Array.from({ length: 20 }, (_, b) => ({ id: `ROOM${r + 1}-B${b + 1}`, benchNo: b + 1 })),
}));

const config = (seed: string, historyDepth: number): EngineConfig => ({
  mode: 'MIXED',
  seed,
  timeBudgetMs: 2000,
  historyDepth,
  weights: {
    sameSeat: 100, sameRoom: 30, sameBenchNo: 10,
    sameLeftNeighbour: 20, sameRightNeighbour: 20,
    sameDeptAdjacent: 15, imbalance: 1, sequentialRoll: 5,
  },
});

function withNeighbours(assignments: { studentId: string; roomId: string; seatId: string; benchNo: number }[]): HistoryExam['assignments'] {
  const byRoom = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const list = byRoom.get(a.roomId) ?? [];
    list.push(a);
    byRoom.set(a.roomId, list);
  }
  const neighbour = new Map<string, { left: string | null; right: string | null }>();
  for (const list of byRoom.values()) {
    list.sort((x, y) => x.benchNo - y.benchNo);
    list.forEach((a, i) =>
      neighbour.set(a.studentId, {
        left: i > 0 ? list[i - 1]!.studentId : null,
        right: i < list.length - 1 ? list[i + 1]!.studentId : null,
      }),
    );
  }
  return assignments.map((a) => ({
    studentId: a.studentId,
    roomId: a.roomId,
    seatId: a.seatId,
    benchNo: a.benchNo,
    leftNeighbourId: neighbour.get(a.studentId)?.left ?? null,
    rightNeighbourId: neighbour.get(a.studentId)?.right ?? null,
  }));
}

function printTable(assignments: { studentId: string; roomId: string; benchNo: number }[]): void {
  const byKey = new Map<string, string>();
  for (const a of assignments) byKey.set(`${a.roomId}:${a.benchNo}`, a.studentId);
  const header = '       ' + Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(4)).join('');
  console.log(header);
  for (const room of rooms) {
    let line = room.id.padEnd(7);
    for (let b = 1; b <= 20; b++) line += (byKey.get(`${room.id}:${b}`) ?? '---').padStart(4);
    console.log(line);
  }
}

function changedRoomCount(prev: HistoryExam, next: { studentId: string; roomId: string; benchNo: number }[]): number {
  const prevByStudent = new Map(prev.assignments.map((a) => [a.studentId, a]));
  let moved = 0;
  for (const a of next) {
    const p = prevByStudent.get(a.studentId);
    if (p && p.roomId !== a.roomId) moved++;
  }
  return moved;
}

function explainHistory(prev: HistoryExam, next: { studentId: string; roomId: string; benchNo: number }[], limit = 4): void {
  const prevByStudent = new Map(prev.assignments.map((a) => [a.studentId, a]));
  const repeated: string[] = [];
  const avoided: string[] = [];
  for (const a of next) {
    const p = prevByStudent.get(a.studentId);
    if (!p) continue;
    const sat = `${p.roomId} bench ${p.benchNo}`;
    const sits = `${a.roomId} bench ${a.benchNo}`;
    if (p.roomId === a.roomId && p.seatId === a.seatId) {
      repeated.push(`Student ${a.studentId} drew the exact same seat (${sits}) as the previous paper.`);
    } else if (p.roomId === a.roomId && p.benchNo === a.benchNo) {
      repeated.push(`Student ${a.studentId} repeated bench number ${p.benchNo} (now ${sits}).`);
    } else if (p.roomId === a.roomId) {
      repeated.push(`Student ${a.studentId} was in ${sat}; the room repeated but the engine moved them to bench ${a.benchNo} within it.`);
    } else if (avoided.length < limit) {
      avoided.push(`Student ${a.studentId} was in ${sat}; this paper the engine penalised ${p.roomId} and bench ${p.benchNo} and placed them in ${sits}.`);
    }
  }
  console.log('\nHow history influenced this paper:');
  const lines = [...repeated.slice(0, 2), ...avoided.slice(0, limit)];
  for (const line of lines.length > 0 ? lines : ['every student received a fresh room and bench number.']) {
    console.log(`  - ${line}`);
  }
}

function runPaper(n: number, history: HistoryExam[]): Extract<EngineResult, { ok: true }> {
  const input: EngineInput = { students, rooms, history, config: config(`demo-paper-${n}`, history.length) };
  const res = generateSeating(input);
  if (!res.ok) {
    console.error(`Paper ${n} failed: ${res.failure.code} — ${res.failure.message}`, res.failure.details ?? '');
    process.exit(1);
  }
  return res;
}

console.log('Exam seating demo — 60 students (20 per department), 3 rooms x 20 benches, 3 papers, MIXED mode.');
console.log('Weights: sameSeat 100, sameRoom 30, sameBenchNo 10, sameNeighbour 20, sameDeptAdjacent 15, imbalance 1, sequentialRoll 5.');

const papers: HistoryExam[] = [];

for (let n = 1; n <= 3; n++) {
  const res = runPaper(n, papers);
  console.log(`\n=== Paper ${n} ===`);
  printTable(res.assignments);
  console.log(`penalty: ${res.penalty}   repeats vs previous paper: sameSeat ${res.stats.sameSeatAsPrev}, sameRoom ${res.stats.sameRoomAsPrev}, sameBenchNo ${res.stats.sameBenchNoAsPrev}, sameNeighbour ${res.stats.sameNeighbourAsPrev}, sameDeptAdjacent ${res.stats.sameDeptAdjacent}`);
  if (n >= 2) {
    const prev = papers[n - 2]!;
    console.log(`\n--- Paper ${n} vs Paper ${n - 1} ---`);
    console.log(`students who changed room: ${changedRoomCount(prev, res.assignments)}/60`);
    explainHistory(prev, res.assignments);
  }
  papers.push({ examId: `P${n}`, order: n, assignments: withNeighbours(res.assignments) });
}
