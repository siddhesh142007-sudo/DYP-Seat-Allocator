import { describe, it, expect } from 'vitest';
import { compareAllocations, type CompareAllocation } from './compare';

function alloc(overrides: Partial<CompareAllocation> & { studentId: string }): CompareAllocation {
  return {
    rollNumber: `R${overrides.studentId}`,
    name: `Student ${overrides.studentId}`,
    departmentCode: 'CSE',
    classroomId: 'room-1',
    roomNumber: '101',
    benchNo: 1,
    ...overrides,
  };
}

describe('compareAllocations', () => {
  it('counts students seated identically as unchanged', () => {
    const a = [alloc({ studentId: 's1' }), alloc({ studentId: 's2', benchNo: 2 })];
    const b = [alloc({ studentId: 's2', benchNo: 2 }), alloc({ studentId: 's1' })];

    const r = compareAllocations(a, b);
    expect(r.moved).toEqual([]);
    expect(r.sameCount).toBe(2);
    expect(r.roomMoves).toBe(0);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it('detects a bench-only move inside the same room', () => {
    const a = [alloc({ studentId: 's1', benchNo: 1 })];
    const b = [alloc({ studentId: 's1', benchNo: 7 })];

    const r = compareAllocations(a, b);
    expect(r.moved).toHaveLength(1);
    expect(r.moved[0]).toMatchObject({
      studentId: 's1',
      from: { roomNumber: '101', benchNo: 1 },
      to: { roomNumber: '101', benchNo: 7 },
      roomChanged: false,
    });
    expect(r.roomMoves).toBe(0);
    expect(r.sameCount).toBe(0);
  });
  it('detects a room move and flags roomMoves', () => {
    const a = [alloc({ studentId: 's1', classroomId: 'room-1', roomNumber: '101', benchNo: 1 })];
    const b = [alloc({ studentId: 's1', classroomId: 'room-2', roomNumber: '102', benchNo: 12 })];

    const r = compareAllocations(a, b);
    expect(r.moved).toHaveLength(1);
    expect(r.roomMoves).toBe(1);
    expect(
      r.moved.map((x) => [x.roomChanged, x.from.classroomId, x.to.classroomId, x.from.benchNo, x.to.benchNo]),
    ).toEqual([[true, 'room-1', 'room-2', 1, 12]]);
  });

  it('splits students present in only one paper into added/removed', () => {
    const a = [alloc({ studentId: 's1' }), alloc({ studentId: 's2' })];
    const b = [alloc({ studentId: 's2' }), alloc({ studentId: 's3' })];

    const r = compareAllocations(a, b);
    expect(r.removed.map((x) => x.studentId)).toEqual(['s1']);
    expect(r.added.map((x) => x.studentId)).toEqual(['s3']);
    expect(r.sameCount).toBe(1);
    expect(r.moved).toEqual([]);
  });

  it('returns empty results for empty inputs', () => {
    expect(compareAllocations([], [])).toEqual({
      moved: [],
      sameCount: 0,
      removed: [],
      added: [],
      roomMoves: 0,
    });
  });

  it('sorts every output list by roll number', () => {
    const a = [
      alloc({ studentId: 'c', rollNumber: '24CSE003' }),
      alloc({ studentId: 'a', rollNumber: '24CSE001' }),
    ];
    const b = [
      alloc({ studentId: 'a', rollNumber: '24CSE001', benchNo: 9 }),
      alloc({ studentId: 'c', rollNumber: '24CSE003', benchNo: 9 }),
      alloc({ studentId: 'd', rollNumber: '24CSE004' }),
    ];

    const r = compareAllocations(a, b);
    expect(r.moved.map((x) => x.rollNumber)).toEqual(['24CSE001', '24CSE003']);
    expect(r.added.map((x) => x.rollNumber)).toEqual(['24CSE004']);
  });
});
