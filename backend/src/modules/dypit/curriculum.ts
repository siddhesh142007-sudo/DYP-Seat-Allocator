/**
 * DYPIT SPPU curriculum master data.
 *
 * Parsers for the two source spreadsheets exported from the official
 * "DYPIT Pune SPPU Engineering Curriculum Handbook" and the FE Subject
 * Directory. Both are pure string -> data functions with no database access so
 * they can be unit-tested against the real files.
 *
 * Curriculum is *informational* metadata: seating is driven by an exam plus
 * AllocationIntents, never by these rows. That is why the parsers are written
 * to degrade gracefully rather than fail loudly on an odd row - a curriculum
 * typo must never block running an exam.
 */

import type { YearCode } from './roll.js';

/** Canonical branch codes. Must stay within [A-Z]{2,6} to match parseRoll(). */
export interface BranchDef {
  code: string;
  name: string;
  /** Sanctioned annual intake, AY 2025-26. */
  seats: number;
}

/** In handbook order. This table is the authoritative source of intake. */
export const DYPIT_BRANCHES: BranchDef[] = [
  { code: 'CE', name: 'Computer Engineering', seats: 240 },
  { code: 'AIDS', name: 'Artificial Intelligence & Data Science', seats: 180 },
  { code: 'ETC', name: 'Electronics & Telecommunication Engineering', seats: 180 },
  { code: 'ME', name: 'Mechanical Engineering', seats: 180 },
  { code: 'CIVIL', name: 'Civil Engineering', seats: 120 },
  { code: 'EE', name: 'Electrical Engineering', seats: 60 },
  { code: 'IT', name: 'Information Technology', seats: 60 },
  { code: 'ECE', name: 'Electronics & Computer Engineering', seats: 60 },
  { code: 'AR', name: 'Automation & Robotics Engineering', seats: 60 },
  { code: 'INSTR', name: 'Instrumentation & Control Engineering', seats: 30 },
];

export type SubjectKind = 'THEORY' | 'LABORATORY' | 'ELECTIVE';

export interface CurriculumSubject {
  name: string;
  yearCode: YearCode;
  semester: number;
  kind: SubjectKind;
  /** FE Physics/Chemistry swap group; only ever set for FE Sem I/II. */
  group?: 'A' | 'B';
}

export interface BranchCurriculum {
  branchCode: string;
  subjects: CurriculumSubject[];
}

/** Page footer that appears between every printed page. */
const FOOTER = /^"?Dr\. D\. Y\. Patil Institute of Technology, Pimpri/i;
/** Branches 7-10 prefix each subject with its year: "SE: Kinematics of Robots". */
const INLINE_YEAR = /^(FE|SE|TE|BE):\s*(.+)$/;

const ROMAN: Record<string, number> = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8,
};

/**
 * First semester of each year of study. FE=Sem I/II, SE=III/IV, TE=V/VI,
 * BE=VII/VIII. Used to anchor header blocks that span several semesters.
 */
const YEAR_FIRST_SEMESTER: Record<YearCode, number> = { FE: 1, SE: 3, TE: 5, BE: 7 };

function romanToInt(raw: string): number | null {
  const key = raw.toUpperCase().replace(/[^IVX]/g, '');
  return ROMAN[key] ?? null;
}

/** Normalises the ligatures and unicode dashes that survive CSV export. */
export function normalise(text: string): string {
  return text
    .replace(/ﬀ/g, 'ff')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi')
    .replace(/ﬄ/g, 'ffl')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits one CSV line honouring double-quoted fields. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      // A doubled quote inside a quoted field is an escaped quote.
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Classifies a subject line into theory / laboratory / elective. */
export function classifySubject(name: string): SubjectKind {
  if (/\belective\b/i.test(name)) return 'ELECTIVE';
  if (/\b(lab|laboratory|practical|workshop|project|internship|studio)\b/i.test(name)) {
    return 'LABORATORY';
  }
  return 'THEORY';
}

/**
 * Best-effort match of a handbook branch label onto a canonical code.
 * Ordered most-specific first: "Electronics & Computer Engineering" must not be
 * captured by the broader Telecommunication / Computer rules.
 */
export function matchBranch(label: string): BranchDef | null {
  const l = normalise(label).toLowerCase();
  if (!l) return null;
  const by = (code: string) => DYPIT_BRANCHES.find((b) => b.code === code)!;
  if (/automation|robotics/.test(l)) return by('AR');
  if (/instrumentation/.test(l)) return by('INSTR');
  if (/electronics and computer|electronics & computer|\bece\b/.test(l)) return by('ECE');
  if (/telecommunication|\betc\b/.test(l)) return by('ETC');
  if (/information technology|\bit\b/.test(l)) return by('IT');
  if (/electrical|\bee\b/.test(l)) return by('EE');
  if (/civil/.test(l)) return by('CIVIL');
  if (/mechanical/.test(l)) return by('ME');
  if (/artificial intelligence|data science|\baids\b/.test(l)) return by('AIDS');
  if (/computer engineering/.test(l) && !/electronics/.test(l)) return by('CE');
  return null;
}

/** Reads year + semester out of one half of a semester header row. */
function parseHeaderCtx(a: string, b: string): { year: YearCode | null; sem: number | null } {
  const text = normalise(`${a} ${b}`);
  const paren = /\((FE|SE|TE|BE)\)/i.exec(text);
  const bareYear = /\b(FE|SE|TE|BE)\b/.exec(text);
  const inlineYear = yearFromText(text);
  const year = (paren?.[1] ?? inlineYear ?? bareYear?.[1] ?? null) as YearCode | null;

  let sem: number | null = null;
  const roman = /\b([IVX]{1,5})\b/.exec(text.replace(/\b(?:FE|SE|TE|BE)\b/gi, ' '));
  if (roman) {
    sem = romanToInt(roman[1]!);
    // Blocks that span several semesters ("Sem III to VIII Roadmap",
    // "TE & BE: Semester V to VIII", "Semester III & IV (SE)") have no single
    // anchor, and the leading roman numeral is frequently the *last* semester
    // of the range. Anchor them at the first semester of the block's year.
    if (/to\s+[IVX]+\b/i.test(text) || /&\s*[IVX]+\b/i.test(text)) {
      if (year) sem = YEAR_FIRST_SEMESTER[year];
    }
  }
  if (sem === null) {
    const arabic = /semester\s+(\d)/i.exec(text);
    if (arabic) sem = Number.parseInt(arabic[1]!, 10);
  }
  return { year, sem };
}

function yearFromText(text: string): YearCode | null {
  const m = INLINE_YEAR.exec(text);
  return m ? (m[1] as YearCode) : null;
}

/**
 * Sem III to VIII roadmap blocks list one row per year group rather than per
 * semester, so the sheet's single anchor (Sem III) is only correct for the SE
 * rows. Map each inline year onto that year's *first* semester instead.
 */

function subjectFromText(
  text: string,
  fallbackYear: YearCode | null,
  fallbackSemester: number | null,
  roadmap = false,
): CurriculumSubject | null {
  const cleaned = normalise(text).replace(/^[•\-*]\s*/, '');
  if (!cleaned) return null;

  const inline = INLINE_YEAR.exec(cleaned);
  // An inline year prefix (branches 7-10) overrides the block header.
  const yearCode = inline ? (inline[1] as YearCode) : fallbackYear;
  const body = inline ? normalise(inline[2]!) : cleaned;
  if (!yearCode) return null;

  // In a roadmap the semester comes from the year, not from the shared anchor.
  const semester =
    roadmap && inline ? YEAR_FIRST_SEMESTER[yearCode] : fallbackSemester;
  if (semester === null) return null;

  return { name: body, yearCode, semester, kind: classifySubject(body) };
}

/** "<name> + <n> Seats" pairs found on one CSV row, in document order. */
export interface BranchSeatPair {
  label: string;
  seats: number;
}

const SEATS_CELL = /^([\d,]+)\s*Seats?$/i;
/** A numbered branch label: "1. Computer Engineering" or bare "Civil Engineering". */
const BRANCH_LABEL = /^(?:\d{1,2}\.\s*)?(?!.*\b(?:pattern|roadmap|page|seats)\b)(.{4,})$/i;

/**
 * The intake table and the branch headers spread a branch across cells:
 *   ",1. Computer Engineering,,240 Seats,"   -> name cell 1, seats cell 3
 *   "9. Automation & Robotics,60 Seats,10. Instrumentation Engineering,30 Seats"
 * so name and seats are matched per row rather than within a single cell.
 */
export function extractBranchSeats(csv: string): BranchSeatPair[] {
  const pairs: BranchSeatPair[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (FOOTER.test(line)) continue;
    const cells = splitCsvLine(line);

    for (let i = 0; i < cells.length; i++) {
      const seatsMatch = SEATS_CELL.exec(cells[i] ?? '');
      if (!seatsMatch) continue;

      // Walk back to the nearest plausible branch label.
      for (let j = i - 1; j >= 0; j--) {
        const label = BRANCH_LABEL.exec(cells[j] ?? '');
        if (!label) continue;
        pairs.push({
          label: normalise(label[1]!).replace(/^\d{1,2}\.\s*/, ''),
          seats: Number.parseInt(seatsMatch[1]!.replace(/,/g, ''), 10),
        });
        break;
      }
    }
  }
  return pairs;
}

/**
 * Reads the sanctioned-intake table at the top of the handbook.
 * Returns [] rather than throwing so callers can fall back to DYPIT_BRANCHES.
 */
export function parseIntakeTable(csv: string): { rows: Array<{ name: string; seats: number }>; total: number } {
  // The same branch appears twice (intake table, then the curriculum body
  // header), under slightly different labels ("Automation & Robotics
  // Engineering" vs "Automation & Robotics"), so dedupe on the canonical code.
  const byCode = new Map<string, { name: string; seats: number }>();
  for (const { label, seats } of extractBranchSeats(csv)) {
    const name = normalise(label).replace(/\s*\(.*?\)\s*$/, '').trim();
    if (!name || !Number.isInteger(seats) || seats <= 0) continue;
    const def = matchBranch(name);
    if (!def) continue;
    if (!byCode.has(def.code)) byCode.set(def.code, { name: def.name, seats });
  }
  const rows = DYPIT_BRANCHES.filter((b) => byCode.has(b.code)).map((b) => ({
    name: b.name,
    seats: byCode.get(b.code)!.seats,
  }));
  return { rows, total: rows.reduce((sum, r) => sum + r.seats, 0) };
}

/**
 * Parses the per-branch curriculum body of the handbook.
 *
 * Handles the three header shapes present in the source:
 *   1. "Semester III (SE),pattern,Semester IV (SE),pattern"        (branches 1-6)
 *   2. "Semester III & IV (SE),Core Track,Semester V & VI (TE)"    (Civil)
 *      "SE: Semester III & IV,,TE & BE: Semester V to VIII,"       (EE, ECE)
 *   3. "Sem III to VIII Roadmap" with the year inline per subject  (branches 9-10)
 */
export function parseHandbook(csv: string): BranchCurriculum[] {
  const lines = csv.split(/\r?\n/);

  // The curriculum body starts at the first "1. Computer Engineering" header
  // that follows the intake table (which lists the same branch earlier).
  let startIdx = 0;
  let seenIntake = false;
  for (let i = 0; i < lines.length; i++) {
    const c0 = normalise(splitCsvLine(lines[i]!)[0] ?? '');
    if (/^OFFICIAL BRANCH SANCTIONED INTAKE/i.test(c0)) seenIntake = true;
    if (seenIntake && /^1\.\s+Computer Engineering/i.test(c0)) {
      startIdx = i;
      break;
    }
  }

  const branches: BranchCurriculum[] = [];
  let current: BranchCurriculum | null = null;
  let leftCtx: { year: YearCode | null; sem: number | null } = { year: null, sem: null };
  let rightCtx: { year: YearCode | null; sem: number | null } = { year: null, sem: null };
  let mergeBoth = false;
  // Branches 9 and 10 share a single table: the left column is branch 9 and
  // the right column is branch 10, so the two halves route to different
  // branches until the next single-branch header.
  let dual: [BranchCurriculum, BranchCurriculum] | null = null;

  const ensureBranch = (code: string): BranchCurriculum => {
    let found = branches.find((b) => b.branchCode === code);
    if (!found) {
      found = { branchCode: code, subjects: [] };
      branches.push(found);
    }
    return found;
  };

  const addSubject = (subject: CurriculumSubject | null, branch?: BranchCurriculum | null) => {
    const target = branch ?? current;
    if (!subject || !target) return;
    const dup = target.subjects.some(
      (s) => s.name === subject.name && s.yearCode === subject.yearCode && s.semester === subject.semester,
    );
    if (!dup) target.subjects.push(subject);
  };

  for (let i = startIdx; i < lines.length; i++) {
    const raw = lines[i]!;
    if (FOOTER.test(raw)) continue;

    const cells = splitCsvLine(raw);
    const c0 = normalise(cells[0] ?? '');

    // --- Branch header, possibly two on one row (branches 9 and 10) ---
    const headerMatch = /^(\d{1,2})\.\s+(.+)$/.exec(c0);
    if (headerMatch && !/^sem/i.test(c0)) {
      const def = matchBranch(headerMatch[2]!);
      if (def) {
        // "(Continued)" / "(Final Year)" blocks continue the same branch, so
        // only switch `current` when the label names a different branch.
        if (!current || current.branchCode !== def.code) {
          current = ensureBranch(def.code);
          dual = null;
        }
        leftCtx = { year: null, sem: null };
        rightCtx = { year: null, sem: null };
        mergeBoth = false;
      }
      // Two branches can share a row: "9. A&R,60 Seats,10. B,30 Seats". The
      // following rows hold branch 9 on the left and branch 10 on the right.
      const extras: BranchCurriculum[] = [];
      for (const pair of extractBranchSeats(raw)) {
        const def2 = matchBranch(pair.label);
        if (def2 && def2.code !== current?.branchCode) {
          const b = ensureBranch(def2.code);
          if (!extras.some((e) => e.branchCode === b.branchCode)) extras.push(b);
        }
      }
      dual = current && extras.length === 1 ? [current, extras[0]!] : null;
      continue;
    }

    // --- Semester header ---
    if (/sem/i.test(c0) && !/^(subject|curriculum)/i.test(c0)) {
      leftCtx = parseHeaderCtx(cells[0] ?? '', cells[1] ?? '');
      rightCtx = parseHeaderCtx(cells[2] ?? '', cells[3] ?? '');
      mergeBoth = /roadmap/i.test(c0);
      if (mergeBoth) rightCtx = leftCtx;
      continue;
    }

    // --- Subject rows: "•,left subject,•,right subject" ---
    const leftRaw = normalise(cells[1] ?? '');
    const rightRaw = normalise(cells[3] ?? '');
    if (leftRaw) addSubject(subjectFromText(leftRaw, leftCtx.year, leftCtx.sem, mergeBoth), dual?.[0] ?? null);
    if (rightRaw) addSubject(subjectFromText(rightRaw, rightCtx.year, rightCtx.sem, mergeBoth), dual?.[1] ?? null);
  }

  return branches.filter((b) => b.subjects.length > 0);
}

/**
 * First Year (FE) subject directory. Sem I/II run a Physics/Chemistry swap:
 * the sheet has two columns, one per group, and the group is named by the
 * column header rather than the semester row.
 *
 *   SEMESTER I
 *   Group A (Physics Group),Sem I,Group B (Chemistry Group),Sem I
 *   SEMESTER II
 *   Group A Divisions (Taking Group B Subjects),Sem II,Group B Divisions …
 *
 * `group` therefore records which column the paper belongs to. Note that in
 * Sem II the *divisions* swap which column they take (Group A divisions sit the
 * Group B papers that semester), so a division's group in a given semester is
 * the opposite of its Sem I column. Seating is driven by roll ranges rather
 * than subjects, so this is reference data only.
 */
export function parseFeDirectory(csv: string): CurriculumSubject[] {
  const out: CurriculumSubject[] = [];
  let semester: number | null = null;
  let leftGroup: 'A' | 'B' = 'A';
  let rightGroup: 'A' | 'B' = 'B';

  for (const line of csv.split(/\r?\n/)) {
    if (FOOTER.test(line)) continue;
    const cells = splitCsvLine(line);
    const c0 = normalise(cells[0] ?? '');

    // A row naming a group in each column header updates the column mapping.
    // Anchor on the *leading* label: the Sem II header reads
    // "Group A Divisions (Taking Group B Subjects)" and so mentions both
    // groups in one cell — matching anywhere would let "Group B" overwrite
    // the column's own "Group A".
    const c2 = normalise(cells[2] ?? '');
    if (/^group\s*a\b/i.test(c0)) leftGroup = 'A';
    else if (/^group\s*b\b/i.test(c0)) leftGroup = 'B';
    if (/^group\s*a\b/i.test(c2)) rightGroup = 'A';
    else if (/^group\s*b\b/i.test(c2)) rightGroup = 'B';

    const semHeader = /SEMESTER\s+(I{1,3}|IV|V)\b/i.exec(c0);
    if (semHeader) {
      semester = romanToInt(semHeader[1]!) ?? null;
      continue;
    }
    if (semester === null) continue;
    if (/^(THEORY|LABORATORY|VALUE|Group\s)/i.test(c0)) continue;

    // Left subject is (0,1), right subject is (2,3).
    const left = normalise(cells[1] ?? '').replace(/^[•\-*]\s*/, '');
    const right = normalise(cells[3] ?? '').replace(/^[•\-*]\s*/, '');
    for (const [name, group] of [[left, leftGroup], [right, rightGroup]] as const) {
      if (!name || /^group/i.test(name)) continue;
      out.push({
        name,
        yearCode: 'FE',
        semester,
        kind: /laboratory/i.test(name) ? 'LABORATORY' : 'THEORY',
        group,
      });
    }
  }
  return out;
}