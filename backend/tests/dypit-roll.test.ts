import { describe, it, expect } from 'vitest';
import {
  parseRoll,
  parseRollOrThrow,
  isYearCode,
  rangeSize,
  rangesOverlap,
  expandRange,
  describeRange,
  type RollRange,
} from '../src/modules/dypit/roll.js';

describe('DYPIT roll number parsing', () => {
  it('parses the confirmed format SE-AIDS-C_07', () => {
    expect(parseRoll('SE-AIDS-C_07')).toEqual({
      yearCode: 'SE',
      branchCode: 'AIDS',
      division: 'C',
      serial: 7,
      serialRaw: '07',
      canonical: 'SE-AIDS-C_07',
    });
  });

  it('parses every year code', () => {
    for (const [roll, year] of [
      ['FE-AIDS-A_01', 'FE'],
      ['SE-AIDS-A_01', 'SE'],
      ['TE-AIDS-A_01', 'TE'],
      ['BE-AIDS-A_01', 'BE'],
    ] as const) {
      expect(parseRoll(roll)?.yearCode).toBe(year);
    }
  });

  it('accepts lowercase and surrounding whitespace by normalising', () => {
    expect(parseRoll('  se-aids-c_07 ')?.canonical).toBe('SE-AIDS-C_07');
  });

  it('accepts an unpadded serial', () => {
    expect(parseRoll('SE-AIDS-C_7')?.serial).toBe(7);
    expect(parseRoll('SE-AIDS-C_7')?.serialRaw).toBe('7');
  });

  it('handles serials above 99 (the case raw string ordering gets wrong)', () => {
    const parsed = parseRoll('SE-CE-A_100');
    expect(parsed?.serial).toBe(100);
    expect(parsed?.branchCode).toBe('CE');
  });

  it('rejects malformed rolls instead of coercing them', () => {
    const bad = [
      '',
      'SE-AIDS-C',
      'SE-AIDS-07', // missing division
      'SE_AIDS_C_07', // wrong separator
      'XX-AIDS-C_07', // unknown year code
      'SE-AIDS-C_0', // serial 0 is not 1-based
      'SE-AIDS-CCCC_07', // division too long
      'SE-AIDS-C_12345', // serial too long
      '24CSE001', // legacy single-token roll
    ];
    for (const roll of bad) {
      expect(parseRoll(roll), `expected ${JSON.stringify(roll)} to be rejected`).toBeNull();
    }
  });

  it('throws a helpful message via parseRollOrThrow', () => {
    expect(() => parseRollOrThrow('nonsense')).toThrow(/Expected DYPIT format/);
    expect(() => parseRollOrThrow('nope', 'range start')).toThrow(/range start/);
  });

  it('identifies year codes', () => {
    expect(isYearCode('SE')).toBe(true);
    expect(isYearCode('XX')).toBe(false);
  });
});

describe('DYPIT roll ranges', () => {
  const base: RollRange = {
    yearCode: 'SE',
    branchCode: 'AIDS',
    division: 'C',
    fromSerial: 1,
    toSerial: 45,
  };

  it('reports its size inclusively', () => {
    expect(rangeSize(base)).toBe(45);
    expect(rangeSize({ ...base, fromSerial: 5, toSerial: 5 })).toBe(1);
  });

  it('detects overlapping ranges for the same cohort', () => {
    expect(rangesOverlap(base, { ...base, fromSerial: 45, toSerial: 60 })).toBe(true);
    expect(rangesOverlap(base, { ...base, fromSerial: 2, toSerial: 10 })).toBe(true);
    expect(rangesOverlap(base, { ...base, fromSerial: 46, toSerial: 90 })).toBe(false);
  });

  it('does not treat different year/branch/division as overlapping', () => {
    expect(rangesOverlap(base, { ...base, yearCode: 'TE' })).toBe(false);
    expect(rangesOverlap(base, { ...base, branchCode: 'CE' })).toBe(false);
    expect(rangesOverlap(base, { ...base, division: 'D' })).toBe(false);
  });

  it('expands to zero-padded canonical rolls', () => {
    expect(expandRange({ ...base, fromSerial: 1, toSerial: 3 })).toEqual([
      'SE-AIDS-C_01',
      'SE-AIDS-C_02',
      'SE-AIDS-C_03',
    ]);
  });

  it('pads to the widest serial in the range', () => {
    expect(expandRange({ ...base, fromSerial: 8, toSerial: 11 })).toEqual([
      'SE-AIDS-C_08',
      'SE-AIDS-C_09',
      'SE-AIDS-C_10',
      'SE-AIDS-C_11',
    ]);
  });

  it('crosses the 99/100 boundary without losing or duplicating a student', () => {
    const rolls = expandRange({ ...base, fromSerial: 98, toSerial: 102 });
    expect(rolls).toEqual([
      'SE-AIDS-C_98',
      'SE-AIDS-C_99',
      'SE-AIDS-C_100',
      'SE-AIDS-C_101',
      'SE-AIDS-C_102',
    ]);
    expect(rolls).toHaveLength(rangeSize({ ...base, fromSerial: 98, toSerial: 102 }));
    expect(new Set(rolls).size).toBe(rolls.length);
  });

  it('describes a range for the UI', () => {
    expect(describeRange(base)).toBe('SE-AIDS-C_01 → SE-AIDS-C_45');
  });
});