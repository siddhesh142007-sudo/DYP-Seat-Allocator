import { randomUUID } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { prisma } from '../../db/prisma.js';
import { UnprocessableError, ValidationError } from '../../common/errors.js';
import { auditLog } from '../audit/audit.service.js';

export const IMPORT_HEADERS = ['room_number', 'building', 'floor', 'bench_count'] as const;

const MAX_ROWS = 500;
const MAX_BENCHES = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface ClassroomImportRowReport {
  row: number;
  roomNumber: string;
  action: 'create' | 'skip' | 'error';
  errors: string[];
}

export interface ClassroomImportReport {
  dryRun: boolean;
  valid: boolean;
  summary: { total: number; created: number; skipped: number; errors: number };
  rows: ClassroomImportRowReport[];
}

interface NormalizedRow {
  roomNumber: string;
  building: string | null;
  floor: string | null;
  benchCount: number | null;
}

const HEADER_ALIASES: Record<string, (typeof IMPORT_HEADERS)[number]> = {
  room_number: 'room_number',
  room: 'room_number',
  roomno: 'room_number',
  room_no: 'room_number',
  classroom: 'room_number',
  building: 'building',
  block: 'building',
  floor: 'floor',
  bench_count: 'bench_count',
  benches: 'bench_count',
  capacity: 'bench_count',
  seats: 'bench_count',
};

function normalizeHeader(raw: unknown): string {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return HEADER_ALIASES[key] ?? key;
}

function rowToStrings(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v == null ? '' : String(v).trim();
  return out;
}

function cellValueToString(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((rt) => rt.text).join('');
    if ('text' in value) return String(value.text);
    if ('result' in value) return value.result == null ? '' : String(value.result);
    return '';
  }
  return String(value).trim();
}

/** Parses an uploaded .csv/.xlsx buffer into normalized row objects. */
export async function parseClassroomFile(filename: string, buffer: Buffer): Promise<Record<string, string>[]> {
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new ValidationError('File is larger than the 5 MB limit');
  }
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) {
    let records: Record<string, unknown>[];
    try {
      records = parseCsv(buffer, {
        bom: true,
        columns: (cols: string[]) => cols.map(normalizeHeader),
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, unknown>[];
    } catch (err) {
      throw new ValidationError(`Could not parse CSV: ${err instanceof Error ? err.message : 'invalid file'}`);
    }
    return records.map(rowToStrings);
  }
  if (lower.endsWith('.xlsx')) {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    } catch {
      throw new ValidationError('Could not parse XLSX file');
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new ValidationError('Workbook has no sheets');

    const headers: (string | null)[] = [];
    sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col - 1] = normalizeHeader(cell.value);
    });

    const rows: Record<string, string>[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const record: Record<string, string> = {};
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const header = headers[col - 1];
        if (header) record[header] = cellValueToString(cell.value);
      });
      rows.push(record);
    });
    return rows;
  }
  throw new ValidationError('Unsupported file type. Upload a .csv or .xlsx file.');
}

export async function buildTemplate(
  bufferFormat: 'csv' | 'xlsx',
): Promise<{ content: Buffer; filename: string; contentType: string }> {
  const example = ['ENG-101', 'Main', '1', '30'];
  if (bufferFormat === 'csv') {
    const content = Buffer.from(`${IMPORT_HEADERS.join(',')}\n${example.join(',')}\n`);
    return { content, filename: 'classrooms-template.csv', contentType: 'text/csv; charset=utf-8' };
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Classrooms');
  sheet.addRow([...IMPORT_HEADERS]);
  sheet.addRow(example);
  const content = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    content,
    filename: 'classrooms-template.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

/**
 * Validates rows and (optionally) applies them: creates each classroom plus
 * its 1..N benches in one transaction. Rows with existing room numbers are
 * skipped untouched. Any row error aborts the whole commit (nothing written).
 */
export async function importClassrooms(
  filename: string,
  buffer: Buffer,
  dryRun: boolean,
  actorId: string,
  ip: string | null,
): Promise<ClassroomImportReport> {
  const rawRows = await parseClassroomFile(filename, buffer);
  if (rawRows.length === 0) throw new ValidationError('The file has no data rows');
  if (rawRows.length > MAX_ROWS) throw new ValidationError(`Too many rows (limit ${MAX_ROWS})`);

  const reports: ClassroomImportRowReport[] = [];
  const prepared: NormalizedRow[] = [];

  const seenRooms = new Set<string>();
  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i]!;
    const rowNumber = i + 2;
    const benchRaw = raw.bench_count ?? '';
    const benchCount = benchRaw === '' ? null : Number(benchRaw);
    const normalized: NormalizedRow = {
      roomNumber: raw.room_number ?? '',
      building: raw.building || null,
      floor: raw.floor || null,
      benchCount: Number.isInteger(benchCount) ? benchCount : null,
    };
    const errors: string[] = [];

    if (!normalized.roomNumber) errors.push('room_number is required');
    else if (normalized.roomNumber.length > 50) errors.push('room_number must be at most 50 characters');
    if (normalized.building && normalized.building.length > 100) errors.push('building must be at most 100 characters');
    if (normalized.floor && normalized.floor.length > 20) errors.push('floor must be at most 20 characters');

    if (benchRaw === '') errors.push('bench_count is required');
    else if (!Number.isInteger(benchCount)) errors.push(`bench_count "${benchRaw}" must be a whole number`);
    else if (benchCount! < 1) errors.push('bench_count must be at least 1');
    else if (benchCount! > MAX_BENCHES) errors.push(`bench_count must be at most ${MAX_BENCHES}`);

    const roomKey = normalized.roomNumber.toLowerCase();
    if (normalized.roomNumber && seenRooms.has(roomKey)) {
      errors.push(`duplicate room_number "${normalized.roomNumber}" in file`);
    } else if (normalized.roomNumber) {
      seenRooms.add(roomKey);
    }

    reports.push({ row: rowNumber, roomNumber: normalized.roomNumber, action: 'error', errors });
    prepared.push(normalized);
  }

  const validRooms = prepared.filter((_, i) => reports[i]!.errors.length === 0).map((r) => r.roomNumber);
  const existingRooms = new Set(
    (await prisma.classroom.findMany({ where: { roomNumber: { in: validRooms } }, select: { roomNumber: true } })).map(
      (c) => c.roomNumber,
    ),
  );

  for (let i = 0; i < prepared.length; i++) {
    const rep = reports[i]!;
    if (rep.errors.length > 0) {
      rep.action = 'error';
      continue;
    }
    rep.action = existingRooms.has(prepared[i]!.roomNumber) ? 'skip' : 'create';
  }

  const errorCount = reports.filter((r) => r.errors.length > 0).length;
  const report = (applied: { created: number; skipped: number }): ClassroomImportReport => ({
    dryRun,
    valid: errorCount === 0,
    summary: { total: rawRows.length, created: applied.created, skipped: applied.skipped, errors: errorCount },
    rows: reports,
  });

  if (dryRun) return report({ created: 0, skipped: 0 });

  if (errorCount > 0) {
    throw new UnprocessableError(
      `Import aborted: ${errorCount} row(s) have errors. Fix them and retry — nothing was imported.`,
      report({ created: 0, skipped: 0 }),
    );
  }

  const toCreate = prepared.filter((_, i) => reports[i]!.action === 'create');
  let created = 0;

  if (toCreate.length > 0) {
    const rooms = toCreate.map((room) => ({ id: randomUUID(), room }));
    const seats = rooms.flatMap(({ id, room }) =>
      Array.from({ length: room.benchCount! }, (_, i) => ({
        classroomId: id,
        benchNumber: i + 1,
        status: 'AVAILABLE' as const,
        rowNo: i + 1,
        colNo: 1,
      })),
    );
    await prisma.$transaction(
      async (tx) => {
        await tx.classroom.createMany({
          data: rooms.map(({ id, room }) => ({
            id,
            roomNumber: room.roomNumber,
            building: room.building,
            floor: room.floor,
            status: 'AVAILABLE',
            capacity: room.benchCount!,
          })),
        });
        await tx.seat.createMany({ data: seats });
      },
      { timeout: 120_000 },
    );
    created = rooms.length;
  }
  const skipped = reports.filter((r) => r.action === 'skip').length;

  await auditLog({
    actorUserId: actorId,
    action: 'classroom.import',
    entityType: 'classroom',
    metadata: { filename, created, skipped, total: rawRows.length },
    ip,
  });
  return report({ created, skipped });
}
