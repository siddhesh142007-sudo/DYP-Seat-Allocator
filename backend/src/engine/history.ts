import type { HistoryExam, PrevAssignment } from './types.js';

export type HistIndex = {
  byStudent: Map<string, Array<{ d: number; a: PrevAssignment }>>;
  depth: number;
};

export function buildHistoryIndex(history: HistoryExam[], historyDepth: number): HistIndex {
  const byStudent = new Map<string, Array<{ d: number; a: PrevAssignment }>>();
  const recent = history.slice().sort((x, y) => y.order - x.order);
  for (let i = 0; i < recent.length && i < historyDepth; i++) {
    const h = recent[i]!;
    for (const a of h.assignments) {
      const list = byStudent.get(a.studentId) || [];
      list.push({ d: i + 1, a });
      byStudent.set(a.studentId, list);
    }
  }
  return { byStudent, depth: Math.min(historyDepth, recent.length) };
}

export function decay(d: number): number {
  return Math.pow(0.5, d - 1);
}
