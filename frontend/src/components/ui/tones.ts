export type BadgeTone = 'success' | 'danger' | 'warning' | 'neutral' | 'brand';

/** Maps API status strings (ACTIVE, UNAVAILABLE…) to badge tones. */
export function statusTone(status: string): BadgeTone {
  if (status === 'ACTIVE' || status === 'AVAILABLE' || status === 'PUBLISHED') return 'success';
  if (status === 'INACTIVE' || status === 'UNAVAILABLE' || status === 'DISABLED') return 'neutral';
  if (status === 'DRAFT' || status === 'PENDING') return 'warning';
  return 'brand';
}

/** Tone for the exam seating lifecycle status. */
export function seatingStatusTone(status: 'NOT_GENERATED' | 'DRAFT' | 'VALIDATED' | 'PUBLISHED'): BadgeTone {
  if (status === 'PUBLISHED') return 'success';
  if (status === 'VALIDATED') return 'brand';
  if (status === 'DRAFT') return 'warning';
  return 'neutral';
}
