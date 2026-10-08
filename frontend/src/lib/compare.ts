/** Pure helpers for the two-paper seating comparison view (Phase 8). */

export interface CompareAllocation {
  studentId: string;
  rollNumber: string;
  name: string;
  departmentCode: string;
  classroomId: string;
  roomNumber: string;
  benchNo: number;
}

export interface SeatRef {
  classroomId: string;
  roomNumber: string;
  benchNo: number;
}

export interface MovedStudent {
  studentId: string;
  rollNumber: string;
  name: string;
  departmentCode: string;
  from: SeatRef;
  to: SeatRef;
  roomChanged: boolean;
}

export interface CompareResult {
  /** Students whose room or bench changed between the two papers. */
  moved: MovedStudent[];
  /** Students seated identically in both papers. */
  sameCount: number;
  /** Seated in A but absent from B. */
  removed: CompareAllocation[];
  /** Seated in B but absent from A. */
  added: CompareAllocation[];
  /** Subset of `moved` where the room itself changed. */
  roomMoves: number;
}

function byRoll(a: { rollNumber: string }, b: { rollNumber: string }): number {
  return a.rollNumber.localeCompare(b.rollNumber);
}

/**
 * Joins two papers' allocations on studentId and reports how each student's
 * seat changed. Deterministic: `moved`/`added`/`removed` are sorted by roll number.
 */
export function compareAllocations(a: CompareAllocation[], b: CompareAllocation[]): CompareResult {
  const inB = new Map(b.map((x) => [x.studentId, x]));
  const inA = new Map(a.map((x) => [x.studentId, x]));

  const moved: MovedStudent[] = [];
  const removed: CompareAllocation[] = [];
  let sameCount = 0;

  for (const left of a) {
    const right = inB.get(left.studentId);
    if (!right) {
      removed.push(left);
      continue;
    }
    const sameRoom = left.classroomId === right.classroomId && left.benchNo === right.benchNo;
    if (sameRoom) {
      sameCount += 1;
      continue;
    }
    moved.push({
      studentId: left.studentId,
      rollNumber: left.rollNumber,
      name: left.name,
      departmentCode: left.departmentCode,
      from: { classroomId: left.classroomId, roomNumber: left.roomNumber, benchNo: left.benchNo },
      to: { classroomId: right.classroomId, roomNumber: right.roomNumber, benchNo: right.benchNo },
      roomChanged: left.classroomId !== right.classroomId,
    });
  }

  const added = b.filter((x) => !inA.has(x.studentId));

  moved.sort(byRoll);
  removed.sort(byRoll);
  added.sort(byRoll);

  return {
    moved,
    sameCount,
    removed,
    added,
    roomMoves: moved.filter((m) => m.roomChanged).length,
  };
}
