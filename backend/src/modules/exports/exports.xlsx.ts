import ExcelJS from 'exceljs';
import {
  DRAFT_WATERMARK,
  type ExportData,
  type RoomSection,
} from './exports.model.js';

type Workbook = ExcelJS.Workbook;
type Worksheet = ExcelJS.Worksheet;

/** Excel sheet names: <=31 chars, no reserved characters, unique (case-insensitive). */
function sheetName(raw: string, used: Set<string>): string {
  const base = raw.replace(/[\\/?*[\]:]/g, '').trim().slice(0, 31) || 'Sheet';
  let name = base;
  let counter = 2;
  while (used.has(name.toLowerCase())) {
    name = `${base.slice(0, 27)}-${counter}`;
    counter += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

function headerBlock(sheet: Worksheet, data: ExportData, section: string): void {
  if (data.watermark) {
    const row = sheet.addRow([DRAFT_WATERMARK]);
    row.font = { bold: true, color: { argb: 'FFDC2626' } };
  }
  const paper = data.exam.paperCode ? ` (${data.exam.paperCode})` : '';
  sheet.addRow([`Exam: ${data.exam.subject}${paper}`]).font = { bold: true };
  sheet.addRow([`Date: ${data.exam.date}    Time: ${data.exam.startTime} - ${data.exam.endTime}`]);
  if (section) sheet.addRow([section]).font = { bold: true };
  sheet.addRow([]);
}

function tableHeader(sheet: Worksheet, labels: string[]): ExcelJS.Row {
  const row = sheet.addRow(labels);
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
  });
  return row;
}

function setWidths(sheet: Worksheet, widths: number[]): void {
  sheet.columns = widths.map((w) => ({ width: w }));
}

async function finish(workbook: Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function addRoomSheet(
  workbook: Workbook,
  used: Set<string>,
  data: ExportData,
  room: RoomSection,
): void {
  const sheet = workbook.addWorksheet(sheetName(room.roomNumber, used));
  const where = [
    `Room ${room.roomNumber}`,
    room.building ? `Building ${room.building}` : null,
    room.floor ? `Floor ${room.floor}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  headerBlock(sheet, data, where);
  tableHeader(sheet, ['Bench', 'Roll No', 'Name', 'Department']);
  for (const s of room.students) {
    sheet.addRow([s.benchNumber, s.rollNumber, s.studentName, s.departmentCode]);
  }
  setWidths(sheet, [9, 16, 32, 18]);
}

export async function buildClassroomXlsx(data: ExportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const used = new Set<string>();
  for (const room of data.rooms) addRoomSheet(workbook, used, data, room);
  if (data.rooms.length === 0) {
    const sheet = workbook.addWorksheet('Seating');
    headerBlock(sheet, data, '');
    tableHeader(sheet, ['Bench', 'Roll No', 'Name', 'Department']);
    setWidths(sheet, [9, 16, 32, 18]);
  }
  return finish(workbook);
}

export async function buildDepartmentXlsx(data: ExportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const used = new Set<string>();
  for (const dept of data.departments) {
    const sheet = workbook.addWorksheet(sheetName(dept.code, used));
    headerBlock(sheet, data, `Department ${dept.code} - ${dept.name}`);
    tableHeader(sheet, ['Roll No', 'Name', 'Room', 'Bench']);
    for (const s of dept.students) sheet.addRow([s.rollNumber, s.studentName, s.roomNumber, s.benchNumber]);
    setWidths(sheet, [16, 32, 14, 9]);
  }
  if (data.departments.length === 0) {
    const sheet = workbook.addWorksheet('Seating');
    headerBlock(sheet, data, '');
    tableHeader(sheet, ['Roll No', 'Name', 'Room', 'Bench']);
    setWidths(sheet, [16, 32, 14, 9]);
  }
  return finish(workbook);
}

export async function buildStudentXlsx(data: ExportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Students');
  headerBlock(sheet, data, 'All students (sorted by roll number)');
  tableHeader(sheet, ['Roll No', 'Name', 'Department', 'Room', 'Bench']);
  for (const s of data.byRoll) {
    sheet.addRow([s.rollNumber, s.studentName, s.departmentCode, s.roomNumber, s.benchNumber]);
  }
  setWidths(sheet, [16, 32, 18, 14, 9]);
  return finish(workbook);
}

export async function buildPlanXlsx(data: ExportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const used = new Set<string>();

  const cover = workbook.addWorksheet(sheetName('Cover', used));
  headerBlock(cover, data, 'Complete seating plan — summary');
  cover.addRow(['Students seated', data.totals.students]);
  cover.addRow(['Rooms used', data.totals.rooms]);
  cover.addRow(['Total penalty', data.totalPenalty ?? '-']);
  cover.addRow(['Run generated', data.generatedAt.toISOString()]);
  cover.addRow([]);
  tableHeader(cover, ['Room', 'Building', 'Floor', 'Students']);
  for (const room of data.rooms) {
    cover.addRow([room.roomNumber, room.building ?? '', room.floor ?? '', room.students.length]);
  }
  const totalRow = cover.addRow(['Total', '', '', data.totals.students]);
  totalRow.font = { bold: true };
  setWidths(cover, [16, 18, 10, 12]);

  const sheetUsed = new Set(used);
  for (const room of data.rooms) addRoomSheet(workbook, sheetUsed, data, room);

  return finish(workbook);
}
