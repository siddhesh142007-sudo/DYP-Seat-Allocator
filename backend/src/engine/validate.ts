import type { Assignment, EngineInput, Room, ValidationReport, Violation } from './types.js';

const DETAIL_LIMIT = 50;

function capList(list: string[]): string[] {
  return list.slice(0, DETAIL_LIMIT);
}

/**
 * Independent validation engine (guide Phase 6). Deliberately does not reuse
 * any allocation or scoring internals: it re-derives every hard constraint
 * straight from the input (eligible students, known rooms/seats) and the
 * proposed assignments. Any violation makes the whole report INVALID so the
 * caller can refuse to save or publish the plan.
 */
export function validate(input: EngineInput, assignments: Assignment[]): ValidationReport {
  const eligible = new Set<string>();
  for (const s of input.students) eligible.add(s.id);

  const roomById = new Map<string, Room>();
  const seatKnown = new Map<string, { roomId: string; enabled: boolean }>();
  const enabledByRoom = new Map<string, number>();
  for (const r of input.rooms) {
    roomById.set(r.id, r);
    let enabled = 0;
    for (const s of r.seats) {
      const isEnabled = s.status !== 'DISABLED';
      if (isEnabled) enabled++;
      if (!seatKnown.has(s.id)) seatKnown.set(s.id, { roomId: r.id, enabled: isEnabled });
    }
    enabledByRoom.set(r.id, enabled);
  }

  const violations: Violation[] = [];
  const duplicateStudents: string[] = [];
  const duplicateSeats: string[] = [];
  const capacityViolations: string[] = [];
  const ineligibleIncluded: string[] = [];
  const unavailableSeatUsed: string[] = [];
  const roomPerSeatMismatch: string[] = [];
  const unassignedIds: string[] = [];

  // duplicate students / duplicate seats
  const studentSeen = new Map<string, number>();
  const seatSeen = new Map<string, number>();
  for (const a of assignments) {
    studentSeen.set(a.studentId, (studentSeen.get(a.studentId) ?? 0) + 1);
    const key = `${a.roomId}:${a.seatId}`;
    seatSeen.set(key, (seatSeen.get(key) ?? 0) + 1);
  }
  for (const [id, count] of studentSeen) {
    if (count > 1) {
      duplicateStudents.push(id);
      violations.push({
        code: 'DUPLICATE_STUDENT',
        message: `Student ${id} holds ${count} seats.`,
        details: { studentId: id, seats: count },
      });
    }
  }
  for (const [key, count] of seatSeen) {
    if (count > 1) {
      duplicateSeats.push(key);
      violations.push({
        code: 'DUPLICATE_SEAT',
        message: `Seat ${key} is assigned to ${count} students.`,
        details: { seat: key, students: count },
      });
    }
  }

  // per-room bookkeeping for capacity + seat provenance
  const usedByRoom = new Map<string, number>();
  for (const a of assignments) {
    usedByRoom.set(a.roomId, (usedByRoom.get(a.roomId) ?? 0) + 1);

    if (!eligible.has(a.studentId)) {
      ineligibleIncluded.push(a.studentId);
      violations.push({
        code: 'INELIGIBLE_STUDENT',
        message: `Student ${a.studentId} is not an eligible participant of this exam.`,
        details: { studentId: a.studentId },
      });
    }

    const known = seatKnown.get(a.seatId);
    if (!known || !known.enabled) {
      const key = `${a.roomId}:${a.seatId}`;
      unavailableSeatUsed.push(key);
      violations.push({
        code: 'UNAVAILABLE_SEAT',
        message: known
          ? `Seat ${a.seatId} in room ${a.roomId} is disabled.`
          : `Seat ${a.seatId} does not exist in the available room data.`,
        details: { seat: key, reason: known ? 'DISABLED' : 'UNKNOWN' },
      });
      continue;
    }
    const room = roomById.get(a.roomId);
    const seatInRoom = room?.seats.some((s) => s.id === a.seatId) ?? false;
    if (known.roomId !== a.roomId || !seatInRoom) {
      const key = `${a.roomId}:${a.seatId}`;
      roomPerSeatMismatch.push(key);
      violations.push({
        code: 'ROOM_SEAT_MISMATCH',
        message: `Seat ${a.seatId} belongs to room ${known.roomId}, not ${a.roomId}.`,
        details: { seat: key, actualRoomId: known.roomId },
      });
    }
  }

  for (const [roomId, used] of usedByRoom) {
    const capacity = enabledByRoom.get(roomId) ?? 0;
    if (used > capacity) {
      capacityViolations.push(roomId);
      violations.push({
        code: 'CAPACITY_EXCEEDED',
        message: `Room ${roomId} holds ${used} students but has ${capacity} available seats.`,
        details: { roomId, used, capacity },
      });
    }
  }

  const assignedIds = new Set(assignments.map((a) => a.studentId));
  for (const id of eligible) {
    if (!assignedIds.has(id)) unassignedIds.push(id);
  }
  if (unassignedIds.length > 0) {
    violations.push({
      code: 'UNASSIGNED_STUDENT',
      message: `${unassignedIds.length} eligible students have no seat.`,
      details: { count: unassignedIds.length, studentIds: capList(unassignedIds) },
    });
  }

  return {
    students: input.students.length,
    assigned: assignments.length,
    unassigned: unassignedIds.length,
    seatsUsed: seatSeen.size,
    duplicateSeats: capList(duplicateSeats),
    duplicateStudents: capList(duplicateStudents),
    capacityViolations: capList(capacityViolations),
    ineligibleIncluded: capList(ineligibleIncluded),
    unavailableSeatUsed: capList(unavailableSeatUsed),
    roomPerSeatMismatch: capList(roomPerSeatMismatch),
    historyConsidered: { enabled: input.config.historyDepth > 0, depth: input.config.historyDepth },
    status: violations.length === 0 ? 'VALID' : 'INVALID',
    violations,
  };
}
