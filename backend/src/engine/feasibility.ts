import type { EngineInput, EngineResult } from './types.js';

function enabledSeatCount(room: { seats: Array<{ status?: 'AVAILABLE' | 'DISABLED' }> }): number {
  let n = 0;
  for (const s of room.seats) if (s.status !== 'DISABLED') n++;
  return n;
}

/**
 * Pre-flight checks (guide §3.8). Returns a structured failure or null when the
 * input can possibly be seated. Every failure carries the exact numbers the API
 * needs for its message ("Additional seats required: X").
 */
export function feasibility(input: EngineInput): EngineResult | null {
  const { students, rooms } = input;
  if (!students || students.length === 0) {
    return {
      ok: false,
      failure: { code: 'NO_ELIGIBLE_STUDENTS', message: 'No eligible students provided.' },
    };
  }
  if (!rooms || rooms.length === 0) {
    return { ok: false, failure: { code: 'NO_AVAILABLE_ROOMS', message: 'No available rooms provided.' } };
  }

  const perRoom = rooms.map((r) => ({ room: r, enabled: enabledSeatCount(r) }));
  const availableSeats = perRoom.reduce((sum, r) => sum + r.enabled, 0);

  if (availableSeats === 0) {
    return { ok: false, failure: { code: 'NO_AVAILABLE_ROOMS', message: 'No available rooms provided.' } };
  }
  if (availableSeats < students.length) {
    return {
      ok: false,
      failure: {
        code: 'INSUFFICIENT_SEATS',
        message: `Not enough seats: ${students.length} students need seats but only ${availableSeats} are available.`,
        details: {
          required: students.length,
          available: availableSeats,
          additionalRequired: students.length - availableSeats,
        },
      },
    };
  }

  const cap = input.config.maxPerDepartment;
  if (cap != null && cap > 0) {
    const byDept = new Map<string, number>();
    for (const s of students) byDept.set(s.departmentId, (byDept.get(s.departmentId) ?? 0) + 1);
    for (const [deptId, count] of byDept) {
      const reachable = perRoom.reduce((sum, r) => sum + Math.min(cap, r.enabled), 0);
      if (count > reachable) {
        return {
          ok: false,
          failure: {
            code: 'DEPARTMENT_RULE_IMPOSSIBLE',
            message:
              `Department ${deptId} has ${count} students but the per-room cap of ${cap} allows at most ` +
              `${reachable} seats across all available rooms.`,
            details: { departmentId: deptId, students: count, maxPerDepartment: cap, reachable },
          },
        };
      }
    }
  }

  return null;
}
