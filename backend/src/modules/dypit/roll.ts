/**
 * DYPIT roll numbers.
 *
 * Canonical shape (confirmed with the college):
 *
 *     SE-AIDS-C_07
 *     |  |    |  ||
 *     |  |    |  +-- serial, 1-based, zero padded
 *     |  |    +----- division letter(s), uppercase A-Z
 *     |  +---------- branch code, matches Department.code
 *     +------------- year of study: FE (1st), SE (2nd), TE (3rd), BE (4th)
 *
 * Students are promoted each year and their roll's year segment changes with
 * them, so only one cohort ever occupies a given yearcode. That is why roll
 * numbers are unique across the college without an admission-year field.
 *
 * Ranges are handled as structured components rather than raw strings: a
 * lexicographic comparison silently mis-orders anything past serial 99
 * ("SE-CE-A_99" sorts *after* "SE-CE-A_100"), so serials are compared
 * numerically.
 */

export const YEAR_CODES = ['FE', 'SE', 'TE', 'BE'] as const;
export type YearCode = (typeof YEAR_CODES)[number];

export interface ParsedRoll {
  /** Year of study, e.g. "SE". */
  yearCode: YearCode;
  /** Branch code as written in the roll, e.g. "AIDS". */
  branchCode: string;
  /** Division letter(s), uppercase A-Z. */
  division: string;
  /** 1-based serial as a number (leading zeros stripped). */
  serial: number;
  /** The serial exactly as written, e.g. "07". */
  serialRaw: string;
  /** Reconstructed canonical form; equal to the input once normalised. */
  canonical: string;
}

export interface RollRange {
  yearCode: YearCode;
  branchCode: string;
  division: string;
  fromSerial: number;
  toSerial: number;
}

/**
 * `SE-AIDS-C_07`. Deliberately strict: a malformed roll must be reported, not
 * silently coerced, or a bad range endpoint would quietly allocate zero
 * students.
 */
const ROLL_PATTERN = /^(FE|SE|TE|BE)-([A-Z]{2,6})-([A-Z]{1,2})_(\d{1,4})$/;

/** DYPIT writes serials zero padded to two digits ("_07", not "_7"). */
export const MIN_SERIAL_WIDTH = 2;

export function isYearCode(value: string): value is YearCode {
  return (YEAR_CODES as readonly string[]).includes(value);
}

/** Parses a DYPIT roll number. Returns null when it does not match the shape. */
export function parseRoll(input: string): ParsedRoll | null {
  const trimmed = input.trim();
  const match = ROLL_PATTERN.exec(trimmed.toUpperCase());
  if (!match) return null;

  const [, yearCode, branchCode, division, serialRaw] = match as unknown as [
    string,
    YearCode,
    string,
    string,
    string,
  ];
  const serial = Number.parseInt(serialRaw, 10);
  // Serial 0 is not a real seat in a division roster; roll numbers are 1-based.
  if (!Number.isInteger(serial) || serial < 1) return null;

  return {
    yearCode,
    branchCode,
    division,
    serial,
    serialRaw,
    canonical: `${yearCode}-${branchCode}-${division}_${serialRaw}`,
  };
}

/** Parses a roll, throwing a message suitable for an API 400 body. */
export function parseRollOrThrow(input: string, label = 'roll number'): ParsedRoll {
  const parsed = parseRoll(input);
  if (!parsed) {
    throw new Error(
      `Invalid ${label} "${input}". Expected DYPIT format like "SE-AIDS-C_07" (year FE/SE/TE/BE, branch, division A-Z, serial).`,
    );
  }
  return parsed;
}

/** Serial span covered by a range. */
export function rangeSize(range: RollRange): number {
  return range.toSerial - range.fromSerial + 1;
}

/** True when `a` and `b` overlap on year/branch/division and serial interval. */
export function rangesOverlap(a: RollRange, b: RollRange): boolean {
  return (
    a.yearCode === b.yearCode &&
    a.branchCode === b.branchCode &&
    a.division === b.division &&
    a.fromSerial <= b.toSerial &&
    b.fromSerial <= a.toSerial
  );
}

/**
 * Expands a roll range into canonical roll strings.
 *
 * Serials are zero padded to a minimum of two digits, matching the DYPIT
 * convention ("_07"). Serials of three or more digits are written unpadded
 * ("_100"), so the width is a floor rather than a uniform field.
 */
export function expandRange(range: RollRange): string[] {
  const rolls: string[] = [];
  for (let n = range.fromSerial; n <= range.toSerial; n++) {
    rolls.push(`${range.yearCode}-${range.branchCode}-${range.division}_${String(n).padStart(MIN_SERIAL_WIDTH, '0')}`);
  }
  return rolls;
}

/** Human-readable rendering, e.g. "SE-AIDS-C_01 → SE-AIDS-C_45". */
export function describeRange(range: RollRange): string {
  const rolls = expandRange(range);
  return `${rolls[0]} → ${rolls[rolls.length - 1]}`;
}