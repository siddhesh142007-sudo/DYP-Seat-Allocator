/** Shared shapes + constants for every seating export (PDF/CSV/XLSX). */

export type ExportFormat = 'pdf' | 'csv' | 'xlsx';

export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PDF_CONTENT_TYPE = 'application/pdf';

export const DRAFT_WATERMARK = 'DRAFT, NOT FOR DISTRIBUTION';

export interface ExamMeta {
  id: string;
  subject: string;
  paperCode: string | null;
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'HH:mm' */
  startTime: string;
  /** 'HH:mm' */
  endTime: string;
}

export interface SeatedStudent {
  rollNumber: string;
  studentName: string;
  departmentCode: string;
  departmentName: string;
  roomNumber: string;
  building: string | null;
  floor: string | null;
  benchNumber: number;
}

export interface RoomSection {
  roomNumber: string;
  building: string | null;
  floor: string | null;
  students: SeatedStudent[];
}

export interface DeptSection {
  code: string;
  name: string;
  students: SeatedStudent[];
}

export interface ExportData {
  exam: ExamMeta;
  runId: string;
  watermark: boolean;
  totalPenalty: number | null;
  generatedAt: Date;
  publishedAt: Date | null;
  rooms: RoomSection[];
  departments: DeptSection[];
  /** every seated student, sorted by roll number */
  byRoll: SeatedStudent[];
  totals: { students: number; rooms: number };
}

export interface ExportFile {
  content: Buffer;
  contentType: string;
  filename: string;
}

/** A single seated student as rendered inside a slip. */
export interface SlipSeat {
  studentName: string;
  rollNumber: string;
  roomNumber: string;
  building: string | null;
  floor: string | null;
  benchNumber: number;
}

/** Safe ASCII fragment for Content-Disposition filenames. */
export function safeName(value: string): string {
  return value
    .replace(/[^A-Za-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
