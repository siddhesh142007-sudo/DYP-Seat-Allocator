import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { prisma } from '../../db/prisma.js';
import { ConflictError, UnprocessableError, ValidationError } from '../../common/errors.js';
import { auditLog } from '../audit/audit.service.js';

export const IMPORT_HEADERS = [
  'roll_number',
  'name',
  'email',
  'division',
  'department_code',
  'academic_year',
  'status',
] as const;

const MAX_ROWS = 2000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface ImportRowReport {
  row: number;
  rollNumber: string;
  name: string;
  action: 'create' | 'update' | 'skip' | 'error';
  errors: string[];
}

export interface ImportReport {
  dryRun: boolean;
  valid: boolean;
  summary: { total: number; created: number; updated: number; skipped: number; errors: number };
  rows: ImportRowReport[];
}

interface NormalizedRow {
  rollNumber: string;
  name: string;
  email: string | null;
  division: string | null;
  departmentCode: string;
  academicYear: string;
  status: 'ACTIVE' | 'INACTIVE' | null;
}

const HEADER_ALIASES: Record<string, (typeof IMPORT_HEADERS)[number]> = {
  roll_number: 'roll_number',
  roll: 'roll_number',
  rollno: 'roll_number',
  roll_number_: 'roll_number',
  name: 'name',
  student_name: 'name',
  email: 'email',
  email_address: 'email',
  division: 'division',
  div: 'division',
  department_code: 'department_code',
  department: 'department_code',
  dept: 'department_code',
  dept_code: 'department_code',
  academic_year: 'academic_year',
  year: 'academic_year',
  status: 'status',
};

function normalizeHeader(raw: unknown): string {
  const key = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return HEADER_ALIASES[key] ?? key;
}

/** Parses an uploaded .csv/.xlsx buffer into normalized row objects. */
export async function parseImportFile(filename: string, buffer: Buffer): Promise<Record<string, string>[]> {
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
    return records.map((r) => rowToStrings(r));
  }
  if (lower.endsWith('.xlsx')) {
    return await parseXlsx(buffer);
  }
  throw new ValidationError('Unsupported file type. Upload a .csv or .xlsx file.');
}

function rowToStrings(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v == null ? '' : String(v).trim();
  }
  return out;
}

async function parseXlsx(buffer: Buffer): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs ships its own Buffer typing; the values are structurally identical.
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new ValidationError('Could not parse XLSX file');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new ValidationError('Workbook has no sheets');

  const headerRow = sheet.getRow(1);
  const headers: (string | null)[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = normalizeHeader(cell.value);
  });

  const rows: Record<string, string>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: Record<string, string> = {};
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const header = headers[col - 1];
      if (!header) return;
      record[header] = cellValueToString(cell.value);
    });
    rows.push(record);
  });
  return rows;
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

export async function buildTemplate(
  bufferFormat: 'csv' | 'xlsx',
): Promise<{ content: Buffer; filename: string; contentType: string }> {
  const example = ['ENG101', 'Asha Patil', 'asha@example.edu', 'A', 'COMP', '2026-27', 'ACTIVE'];
  if (bufferFormat === 'csv') {
    const content = Buffer.from(([IMPORT_HEADERS.join(','), example.join(',')].join('\n') + '\n').trimEnd() + '\n');
    return { content, filename: 'students-template.csv', contentType: 'text/csv; charset=utf-8' };
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Students');
  sheet.addRow([...IMPORT_HEADERS]);
  sheet.addRow(example);
  const content: Buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { content, filename: 'students-template.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

/** Validates rows and (optionally) applies them. Commit with errors = nothing written. */
export async function importStudents(
  filename: string,
  buffer: Buffer,
  dryRun: boolean,
  actorId: string,
  ip: string | null,
): Promise<ImportReport> {
  const rawRows = await parseImportFile(filename, buffer);
  if (rawRows.length === 0) throw new ValidationError('The file has no data rows');
  if (rawRows.length > MAX_ROWS) throw new ValidationError(`Too many rows (limit ${MAX_ROWS})`);

  const [departments, years] = await Promise.all([
    prisma.department.findMany({ select: { id: true, code: true, name: true } }),
    prisma.academicYear.findMany({ select: { id: true, code: true, name: true } }),
  ]);
  const deptByLookup = new Map<string, string>();
  for (const d of departments) {
    deptByLookup.set(d.code.toLowerCase(), d.id);
    deptByLookup.set(d.name.toLowerCase(), d.id);
  }
  const yearByLookup = new Map<string, string>();
  for (const y of years) {
    yearByLookup.set(y.name.toLowerCase(), y.id);
    if (y.code) yearByLookup.set(y.code.toLowerCase(), y.id);
  }

  const seenRolls = new Set<string>();
  const reports: ImportRowReport[] = [];
  const prepared: { row: number; normalized: NormalizedRow; existingId: string | null; changed: boolean }[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i]!;
    const rowNumber = i + 2; // 1-based incl. header row
    const normalized: NormalizedRow = {
      rollNumber: raw.roll_number ?? '',
      name: raw.name ?? '',
      email: raw.email ? raw.email.toLowerCase() : null,
      division: raw.division || null,
      departmentCode: raw.department_code ?? '',
      academicYear: raw.academic_year ?? '',
      status: raw.status ? (raw.status.toUpperCase() as 'ACTIVE' | 'INACTIVE') : null,
    };
    const errors: string[] = [];

    if (!normalized.rollNumber) errors.push('roll_number is required');
    else if (normalized.rollNumber.length > 50) errors.push('roll_number must be at most 50 characters');
    if (!normalized.name) errors.push('name is required');
    if (normalized.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) {
      errors.push(`invalid email "${normalized.email}"`);
    }
    if (normalized.status && normalized.status !== 'ACTIVE' && normalized.status !== 'INACTIVE') {
      errors.push(`invalid status "${normalized.status}" (use ACTIVE or INACTIVE)`);
    }

    const departmentId = normalized.departmentCode ? deptByLookup.get(normalized.departmentCode.toLowerCase()) : undefined;
    if (!normalized.departmentCode) errors.push('department_code is required');
    else if (!departmentId) errors.push(`unknown department "${normalized.departmentCode}"`);

    const academicYearId = normalized.academicYear ? yearByLookup.get(normalized.academicYear.toLowerCase()) : undefined;
    if (!normalized.academicYear) errors.push('academic_year is required');
    else if (!academicYearId) errors.push(`unknown academic year "${normalized.academicYear}"`);

    const rollKey = normalized.rollNumber.toLowerCase();
    if (normalized.rollNumber && seenRolls.has(rollKey)) {
      errors.push(`duplicate roll_number "${normalized.rollNumber}" in file`);
    } else if (normalized.rollNumber) {
      seenRolls.add(rollKey);
    }

    reports.push({ row: rowNumber, rollNumber: normalized.rollNumber, name: normalized.name, action: 'error', errors });
    prepared.push({ row: rowNumber, normalized, existingId: null, changed: true });
  }

  // Batch-resolve existing students for all rows that passed validation.
  const validRolls = prepared
    .filter((_, i) => reports[i]!.errors.length === 0)
    .map((p) => p.normalized.rollNumber);
  const existingByRoll = new Map(
    (
      await prisma.student.findMany({
        where: { rollNumber: { in: validRolls } },
        select: { id: true, rollNumber: true, name: true, email: true, division: true, status: true, academicYearId: true, departmentId: true },
      })
    ).map((s) => [s.rollNumber, s]),
  );

  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i]!;
    const rep = reports[i]!;
    if (rep.errors.length > 0) {
      rep.action = 'error';
      continue;
    }
    const academicYearId = yearByLookup.get(item.normalized.academicYear.toLowerCase())!;
    const departmentId = deptByLookup.get(item.normalized.departmentCode.toLowerCase())!;
    const existing = existingByRoll.get(item.normalized.rollNumber);
    if (!existing) {
      item.existingId = null;
      rep.action = 'create';
      continue;
    }
    item.existingId = existing.id;
    item.changed =
      existing.name !== item.normalized.name ||
      existing.email !== (item.normalized.email ?? null) ||
      existing.division !== (item.normalized.division ?? null) ||
      existing.academicYearId !== academicYearId ||
      existing.departmentId !== departmentId ||
      (item.normalized.status !== null && existing.status !== item.normalized.status);
    rep.action = item.changed ? 'update' : 'skip';
  }

  const errorCount = reports.filter((r) => r.errors.length > 0).length;
  const report = (applied: { created: number; updated: number; skipped: number }): ImportReport => ({
    dryRun,
    valid: errorCount === 0,
    summary: {
      total: rawRows.length,
      created: applied.created,
      updated: applied.updated,
      skipped: applied.skipped,
      errors: errorCount,
    },
    rows: reports,
  });

  if (dryRun) {
    return report({ created: 0, updated: 0, skipped: 0 });
  }

  if (errorCount > 0) {
    throw new UnprocessableError(
      `Import aborted: ${errorCount} row(s) have errors. Fix them and retry — nothing was imported.`,
      report({ created: 0, updated: 0, skipped: 0 }),
    );
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  try {
    await prisma.$transaction(
      async (tx) => {
        // One bulk insert for new rows; per-row updates only where data changed.
        const toCreate = prepared.filter((p) => p.existingId === null);
        if (toCreate.length > 0) {
          await tx.student.createMany({
            data: toCreate.map((item) => ({
              rollNumber: item.normalized.rollNumber,
              name: item.normalized.name,
              email: item.normalized.email,
              division: item.normalized.division,
              status: item.normalized.status ?? 'ACTIVE',
              departmentId: deptByLookup.get(item.normalized.departmentCode.toLowerCase())!,
              academicYearId: yearByLookup.get(item.normalized.academicYear.toLowerCase())!,
            })),
          });
          created = toCreate.length;
        }
        for (const item of prepared) {
          if (item.existingId === null) continue;
          if (!item.changed) {
            skipped++;
            continue;
          }
          await tx.student.update({
            where: { id: item.existingId },
            data: {
              name: item.normalized.name,
              email: item.normalized.email,
              division: item.normalized.division,
              departmentId: deptByLookup.get(item.normalized.departmentCode.toLowerCase())!,
              academicYearId: yearByLookup.get(item.normalized.academicYear.toLowerCase())!,
              ...(item.normalized.status !== null ? { status: item.normalized.status } : {}),
            },
          });
          updated++;
        }
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (err) {
    // Rollback already happened; surface the DB error clearly.
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002') {
      throw new ConflictError('A row collided with existing unique data (roll number or email). Nothing was imported.');
    }
    throw err;
  }

  await auditLog({
    actorUserId: actorId,
    action: 'student.import',
    entityType: 'student',
    metadata: { filename, created, updated, skipped, total: rawRows.length },
    ip,
  });
  return report({ created, updated, skipped });
}
