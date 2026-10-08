import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DYPIT_BRANCHES,
  parseIntakeTable,
  parseHandbook,
  parseFeDirectory,
  classifySubject,
  matchBranch,
  splitCsvLine,
  normalise,
  extractBranchSeats,
} from '../src/modules/dypit/curriculum.js';
import { parseRoll } from '../src/modules/dypit/roll.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(here, '..', 'seed-data');
const handbook = readFileSync(join(SEED_DIR, 'curriculum-handbook.csv'), 'utf8');
const feCsv = readFileSync(join(SEED_DIR, 'fe-subjects.csv'), 'utf8');

describe('splitCsvLine', () => {
  it('respects quoted fields containing commas', () => {
    expect(splitCsvLine('•,"Surveying Principles, Fieldwork & Advanced Surveying",•,X')).toEqual([
      '•',
      'Surveying Principles, Fieldwork & Advanced Surveying',
      '•',
      'X',
    ]);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(splitCsvLine('a,"say ""hi""",b')).toEqual(['a', 'say "hi"', 'b']);
  });
});

describe('normalise', () => {
  it('repairs PDF ligatures and unicode dashes', () => {
    expect(normalise('Artiﬁcial Intelligence')).toBe('Artificial Intelligence');
    expect(normalise('Theory – Practice')).toBe('Theory - Practice');
  });
});

describe('classifySubject', () => {
  it('detects electives, laboratories and theory', () => {
    expect(classifySubject('Elective I (Cyber Security / HCI)')).toBe('ELECTIVE');
    expect(classifySubject('Data Structures & OOP Laboratory')).toBe('LABORATORY');
    expect(classifySubject('Discrete Mathematics')).toBe('THEORY');
  });
});

describe('matchBranch', () => {
  it('maps handbook labels onto canonical codes', () => {
    expect(matchBranch('Computer Engineering')?.code).toBe('CE');
    expect(matchBranch('1. Computer Engineering (Continued — Final Year / B.E.)')?.code).toBe('CE');
    expect(matchBranch('Artificial Intelligence & Data Science (AI & DS)')?.code).toBe('AIDS');
    expect(matchBranch('Electronics & Telecommunication Engineering (E&TC)')?.code).toBe('ETC');
    expect(matchBranch('Electronics and Computer Engineering (ECE)')?.code).toBe('ECE');
    expect(matchBranch('Automation & Robotics')?.code).toBe('AR');
    expect(matchBranch('Instrumentation Engineering')?.code).toBe('INSTR');
  });

  it('does not confuse Electronics & Computer with E&TC', () => {
    expect(matchBranch('Electronics and Computer Engineering (ECE)')?.code).not.toBe('ETC');
  });

  it('returns null for an unknown label', () => {
    expect(matchBranch('School of Liberal Arts')).toBeNull();
  });
});

describe('branch codes are valid in roll numbers', () => {
  it('every canonical branch code parses inside a DYPIT roll', () => {
    for (const branch of DYPIT_BRANCHES) {
      expect(parseRoll(`SE-${branch.code}-A_01`), `${branch.code} must match the roll grammar`).not.toBeNull();
    }
  });
});

describe('extractBranchSeats', () => {
  it('pairs a name with a seats cell even when they sit in different columns', () => {
    const pairs = extractBranchSeats(',1. Computer Engineering,,240 Seats,');
    expect(pairs).toEqual([{ label: 'Computer Engineering', seats: 240 }]);
  });

  it('handles two branches sharing one row', () => {
    const pairs = extractBranchSeats('9. Automation & Robotics,60 Seats,10. Instrumentation Engineering,30 Seats');
    expect(pairs).toEqual([
      { label: 'Automation & Robotics', seats: 60 },
      { label: 'Instrumentation Engineering', seats: 30 },
    ]);
  });
});

describe('parseIntakeTable (real handbook)', () => {
  const intake = parseIntakeTable(handbook);

  it('finds all ten branches', () => {
    expect(intake.rows).toHaveLength(10);
  });

  it('totals the sanctioned intake to 1,170', () => {
    expect(intake.total).toBe(1170);
  });

  it('reads the documented per-branch intake', () => {
    const seats = Object.fromEntries(intake.rows.map((r) => [r.name, r.seats]));
    expect(seats['Computer Engineering']).toBe(240);
    expect(seats['Artificial Intelligence & Data Science']).toBe(180);
    expect(seats['Civil Engineering']).toBe(120);
    expect(seats['Instrumentation & Control Engineering']).toBe(30);
  });

  it('agrees with the published DYPIT_BRANCHES table', () => {
    expect(intake.total).toBe(DYPIT_BRANCHES.reduce((sum, b) => sum + b.seats, 0));
  });
});

describe('parseHandbook (real handbook)', () => {
  const branches = parseHandbook(handbook);

  it('finds every branch', () => {
    expect(branches.map((b) => b.branchCode).sort()).toEqual(
      DYPIT_BRANCHES.map((b) => b.code).sort(),
    );
  });

  it('gives every branch at least one subject', () => {
    for (const branch of branches) {
      expect(branch.subjects.length, branch.branchCode).toBeGreaterThan(0);
    }
  });

  it('never attributes a subject to a semester its year does not have', () => {
    // FE I/II, SE III/IV, TE V/VI, BE VII/VIII.
    const allowed: Record<string, number[]> = {
      FE: [1, 2],
      SE: [3, 4],
      TE: [5, 6],
      BE: [7, 8],
    };
    for (const branch of branches) {
      for (const subject of branch.subjects) {
        expect(allowed[subject.yearCode], `${branch.branchCode} ${subject.name}`).toContain(
          subject.semester,
        );
      }
    }
  });

  it('splits the shared AR/INSTR table across both branches', () => {
    const ar = branches.find((b) => b.branchCode === 'AR')!;
    const instr = branches.find((b) => b.branchCode === 'INSTR')!;
    expect(ar.subjects.length).toBeGreaterThan(0);
    expect(instr.subjects.length).toBeGreaterThan(0);
    // AR keeps the robot subjects, INSTR the instrumentation ones.
    expect(ar.subjects.some((s) => /Kinematics of Robots/i.test(s.name))).toBe(true);
    expect(instr.subjects.some((s) => /Sensors & Transducers/i.test(s.name))).toBe(true);
  });

  it('does not duplicate a subject inside one branch/semester', () => {
    for (const branch of branches) {
      const keys = branch.subjects.map((s) => `${s.name}|${s.yearCode}|${s.semester}`);
      expect(new Set(keys).size, branch.branchCode).toBe(keys.length);
    }
  });

  it('parses the Computer Engineering semesters it can check by name', () => {
    const ce = branches.find((b) => b.branchCode === 'CE')!;
    const names = ce.subjects.map((s) => s.name);
    expect(names).toContain('Discrete Mathematics');
    expect(names).toContain('Design and Analysis of Algorithms');
    // "Design and Analysis of Algorithms" is a Sem VII (BE) paper.
    const daa = ce.subjects.find((s) => s.name === 'Design and Analysis of Algorithms')!;
    expect(daa.yearCode).toBe('BE');
    expect(daa.semester).toBe(7);
  });
});

describe('parseFeDirectory (real FE file)', () => {
  const subjects = parseFeDirectory(feCsv);

  it('reads both first-year semesters', () => {
    expect(subjects.some((s) => s.semester === 1)).toBe(true);
    expect(subjects.some((s) => s.semester === 2)).toBe(true);
  });

  it('keeps both the Physics and Chemistry groups in each semester', () => {
    for (const semester of [1, 2]) {
      const groups = new Set(subjects.filter((s) => s.semester === semester).map((s) => s.group));
      expect(groups, `Sem ${semester} groups`).toEqual(new Set(['A', 'B']));
    }
  });

  it('covers the common first-year papers', () => {
    const names = subjects.map((s) => s.name);
    expect(names).toContain('Engineering Mathematics - I');
    expect(names).toContain('Engineering Physics');
    expect(names).toContain('Engineering Chemistry');
    expect(names).toContain('Professional Communication Skills');
  });

  it('marks the Physics/Chemistry swap per semester', () => {
    // Sem I: group A is the Physics column, so Physics is group A.
    const physics1 = subjects.find((s) => s.name === 'Engineering Physics' && s.semester === 1)!;
    expect(physics1.group).toBe('A');
    // Sem II: group A divisions sit the Chemistry column.
    const chemistry2 = subjects.find((s) => s.name === 'Engineering Chemistry' && s.semester === 2)!;
    expect(chemistry2.group).toBe('A');
  });

  it('classifies laboratories', () => {
    expect(subjects.filter((s) => s.kind === 'LABORATORY').length).toBeGreaterThan(0);
  });
});