export type Student = {
  id: string;
  rollNo: string;
  departmentId: string;
  divisionId?: string | null;
};

export type Seat = {
  id: string;
  benchNo: number;
  row?: number | null;
  col?: number | null;
  /** Omitted means AVAILABLE. DISABLED seats are never allocated. */
  status?: 'AVAILABLE' | 'DISABLED';
};

export type Room = {
  id: string;
  building?: string | null;
  roomNumber?: string | null;
  seats: Seat[];
};

export type Assignment = {
  studentId: string;
  roomId: string;
  seatId: string;
  benchNo: number;
};

export type PrevAssignment = Assignment & {
  leftNeighbourId?: string | null;
  rightNeighbourId?: string | null;
};

export type HistoryExam = {
  examId: string;
  /** Larger = more recent. d = 1 (the latest previous paper) gets the highest order. */
  order: number;
  assignments: PrevAssignment[];
};

export type PenaltyWeights = {
  sameSeat: number;
  sameRoom: number;
  sameBenchNo: number;
  sameLeftNeighbour: number;
  sameRightNeighbour: number;
  sameDeptAdjacent: number;
  imbalance: number;
  sequentialRoll: number;
};

export type EngineConfig = {
  mode: 'MIXED' | 'BLOCK';
  seed?: string | number;
  timeBudgetMs: number;
  historyDepth: number;
  weights: PenaltyWeights;
  /**
   * Optional per-room cap on students of one department (guide §3.7).
   * When provided the engine enforces it during construction and fails with
   * DEPARTMENT_RULE_IMPOSSIBLE if no arrangement can satisfy it.
   */
  maxPerDepartment?: number | null;
  /** Candidate seats sampled per student during greedy construction (default 16). */
  kCandidates?: number;
};

export type EngineInput = {
  students: Student[];
  rooms: Room[];
  history: HistoryExam[];
  config: EngineConfig;
};

export type Violation = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type ValidationReport = {
  students: number;
  assigned: number;
  unassigned: number;
  seatsUsed: number;
  duplicateSeats: string[];
  duplicateStudents: string[];
  capacityViolations: string[];
  ineligibleIncluded: string[];
  unavailableSeatUsed: string[];
  roomPerSeatMismatch: string[];
  historyConsidered: { enabled: boolean; depth: number };
  status: 'VALID' | 'INVALID';
  violations: Violation[];
};

export type Breakdown = {
  sameSeat: number;
  sameRoom: number;
  sameBenchNo: number;
  sameNeighbour: number;
  sameDeptAdjacent: number;
  imbalance: number;
  sequentialRoll: number;
};

export type Stats = {
  sameSeatAsPrev: number;
  sameRoomAsPrev: number;
  sameBenchNoAsPrev: number;
  sameNeighbourAsPrev: number;
  sameDeptAdjacent: number;
  timeMs: number;
  iterations: number;
};

export type EngineSuccess = {
  ok: true;
  assignments: Assignment[];
  penalty: number;
  breakdown: Breakdown;
  stats: Stats;
  seed: string;
  timing: { totalMs: number; allocateMs: number; improveMs: number; validateMs: number };
};

export type FailureCode =
  | 'INSUFFICIENT_SEATS'
  | 'NO_ELIGIBLE_STUDENTS'
  | 'NO_AVAILABLE_ROOMS'
  | 'DEPARTMENT_RULE_IMPOSSIBLE'
  | 'VALIDATION_FAILED'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';

export type EngineFailure = {
  ok: false;
  failure: {
    code: FailureCode;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type EngineResult = EngineSuccess | EngineFailure;
