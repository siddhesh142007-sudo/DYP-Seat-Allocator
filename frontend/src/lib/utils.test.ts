import { describe, it, expect } from 'vitest';
import { cn, formatExamDate, formatExamTime } from './utils';

describe('cn', () => {
  it('merges class names, last one winning on conflicts', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-sm', 'text-lg', 'font-bold')).toBe('text-lg font-bold');
  });

  it('handles conditional values', () => {
    const toggle = (v: boolean) => v;
    expect(cn('base', toggle(false) && 'hidden', undefined, null)).toBe('base');
  });
});

describe('formatExamDate', () => {
  it('renders the day, month name and year', () => {
    expect(formatExamDate('2026-09-10')).toBe('10 September 2026');
    expect(formatExamDate('2026-01-01')).toBe('1 January 2026');
    expect(formatExamDate('2026-12-31')).toBe('31 December 2026');
  });

  it('returns the input untouched when malformed', () => {
    expect(formatExamDate('not-a-date')).toBe('not-a-date');
    expect(formatExamDate('')).toBe('');
  });
});

describe('formatExamTime', () => {
  it('converts 24-hour times to 12-hour with a meridiem', () => {
    expect(formatExamTime('10:00')).toBe('10:00 AM');
    expect(formatExamTime('00:30')).toBe(12 + ':30 AM');
    expect(formatExamTime('12:00')).toBe('12:00 PM');
    expect(formatExamTime('13:05')).toBe('1:05 PM');
    expect(formatExamTime('23:59')).toBe('11:59 PM');
  });

  it('returns the input untouched when malformed', () => {
    expect(formatExamTime('9')).toBe('9');
    expect(formatExamTime('')).toBe('');
  });
});
