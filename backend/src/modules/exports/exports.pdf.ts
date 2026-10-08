import PDFDocument from 'pdfkit';
import { drawSlip, shortStamp, type PdfDoc, type SlipPayload } from '../../common/pdfSlip.js';
import {
  DRAFT_WATERMARK,
  type ExportData,
  type SeatedStudent,
  type SlipSeat,
} from './exports.model.js';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 42;
const ROW_H = 15;
const BOTTOM = PAGE_H - M;

interface Col {
  label: string;
  width: number;
}

interface DocBundle {
  doc: PdfDoc;
  finish: () => Promise<Buffer>;
}

function newDoc(data: ExportData): DocBundle {
  const doc = new PDFDocument({ size: 'A4', margin: M, compress: false });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  if (data.watermark) {
    // pdfkit creates the first page inside the constructor (no 'pageAdded'
    // event), so watermark it manually; later pages fire the event.
    doc.on('pageAdded', () => drawWatermark(doc));
    drawWatermark(doc);
  }
  return {
    doc,
    finish: async () => {
      doc.end();
      await finished;
      return Buffer.concat(chunks);
    },
  };
}

function drawWatermark(doc: PdfDoc): void {
  doc.save();
  doc.translate(PAGE_W / 2, PAGE_H / 2);
  doc.rotate(-32);
  doc.fillOpacity(0.14);
  doc.fillColor('#334155').font('Helvetica-Bold').fontSize(34);
  doc.text(DRAFT_WATERMARK, -PAGE_W / 2, -24, { width: PAGE_W, align: 'center', lineBreak: false });
  doc.fillOpacity(1);
  doc.restore();
}

/** Longest prefix of `raw` that fits `maxWidth` in the current font, ellipsized. */
function fitText(doc: PdfDoc, raw: string, maxWidth: number): string {
  if (raw.length === 0 || doc.widthOfString(raw) <= maxWidth) return raw;
  const ellipsis = '…';
  let lo = 1;
  let hi = raw.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(`${raw.slice(0, mid)}${ellipsis}`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${raw.slice(0, lo)}${ellipsis}`;
}

function pageHeader(doc: PdfDoc, title: string, data: ExportData): number {
  doc.x = M;
  doc.y = M;
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#0F172A').text(title, M, M, { lineBreak: false });
  let y = M + 22;
  const paper = data.exam.paperCode ? ` (${data.exam.paperCode})` : '';
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor('#334155')
    .text(`${data.exam.subject}${paper} · ${data.exam.date} · ${data.exam.startTime} - ${data.exam.endTime}`, M, y, {
      lineBreak: false,
    });
  y += 14;
  if (data.watermark) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#DC2626').text(DRAFT_WATERMARK, M, y, { lineBreak: false });
    y += 13;
  }
  doc.moveTo(M, y + 2).lineTo(PAGE_W - M, y + 2).strokeColor('#CBD5E1').lineWidth(1).stroke();
  return y + 12;
}

/** Starts a fresh page (watermark fires via 'pageAdded') and draws its header. */
function newPage(doc: PdfDoc, title: string, data: ExportData): number {
  doc.addPage();
  return pageHeader(doc, title, data);
}

function tableHead(doc: PdfDoc, cols: Col[], y: number): number {
  let x = M;
  const h = 16;
  doc.rect(M, y, PAGE_W - 2 * M, h).fill('#F1F5F9');
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#0F172A');
  for (const col of cols) {
    doc.text(col.label, x + 5, y + 4, { width: col.width - 8, lineBreak: false });
    x += col.width;
  }
  doc.fillColor('#0F172A');
  return y + h + 3;
}

function tableRow(doc: PdfDoc, cells: Array<string | number>, cols: Col[], y: number): number {
  let x = M;
  doc.font('Helvetica').fontSize(9).fillColor('#1E293B');
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i]!;
    const value = fitText(doc, String(cells[i] ?? ''), col.width - 8);
    doc.text(value, x + 5, y, { width: col.width - 8, lineBreak: false });
    x += col.width;
  }
  doc
    .moveTo(M, y + ROW_H - 3)
    .lineTo(PAGE_W - M, y + ROW_H - 3)
    .strokeColor('#E2E8F0')
    .lineWidth(0.5)
    .stroke();
  return y + ROW_H;
}

const ROOM_COLS: Col[] = [
  { label: 'Bench', width: 55 },
  { label: 'Roll No', width: 170 },
  { label: 'Name', width: 150 },
  { label: 'Department', width: 136 },
];

const ROLL_COLS: Col[] = [
  { label: 'Roll No', width: 170 },
  { label: 'Name', width: 180 },
  { label: 'Room', width: 95 },
  { label: 'Bench', width: 66 },
];

const ROLL_DEPT_COLS: Col[] = [
  { label: 'Roll No', width: 170 },
  { label: 'Name', width: 137 },
  { label: 'Department', width: 90 },
  { label: 'Room', width: 78 },
  { label: 'Bench', width: 36 },
];

function sectionTitle(doc: PdfDoc, text: string, sub: string | null, y: number): number {
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0F172A').text(text, M, y, { lineBreak: false });
  if (sub) {
    doc.font('Helvetica').fontSize(9).fillColor('#64748B').text(sub, M + doc.widthOfString(text) + 12, y + 2, {
      lineBreak: false,
    });
  }
  return y + 18;
}

function signatureLine(doc: PdfDoc, y: number): number {
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#334155')
    .text('Invigilator Signature: ______________________________', M, y, { lineBreak: false });
  return y + 26;
}

function roomSub(room: { building: string | null; floor: string | null }): string {
  return [
    room.building ? `Building ${room.building}` : null,
    room.floor ? `Floor ${room.floor}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Generic section-per-group renderer used by classroom- and department-wise lists. */
function renderSections(
  doc: PdfDoc,
  data: ExportData,
  title: string,
  groups: Array<{ heading: string; sub: string | null; students: SeatedStudent[]; cols: Col[]; cells: (s: SeatedStudent) => Array<string | number>; signature: boolean }>,
): void {
  let y = pageHeader(doc, title, data);
  for (const group of groups) {
    if (y + 70 > BOTTOM) {
      y = newPage(doc, title, data);
    }
    y = sectionTitle(doc, group.heading, group.sub, y);
    y = tableHead(doc, group.cols, y);
    for (const s of group.students) {
      if (y + ROW_H > BOTTOM) {
        y = newPage(doc, `${title} (continued)`, data);
        y = sectionTitle(doc, group.heading, group.sub, y);
        y = tableHead(doc, group.cols, y);
      }
      y = tableRow(doc, group.cells(s), group.cols, y);
    }
    if (group.signature) {
      if (y + 40 > BOTTOM) y = newPage(doc, `${title} (continued)`, data);
      y = signatureLine(doc, y + 6);
    }
    y += 14;
  }
}

async function bufferOf(bundle: DocBundle): Promise<Buffer> {
  return bundle.finish();
}

export async function classroomPdf(data: ExportData): Promise<Buffer> {
  const bundle = newDoc(data);
  renderSections(
    bundle.doc,
    data,
    'Classroom-wise Seating List',
    data.rooms.map((room) => ({
      heading: `Room ${room.roomNumber}`,
      sub: roomSub(room),
      students: room.students,
      cols: ROOM_COLS,
      cells: (s) => [s.benchNumber, s.rollNumber, s.studentName, s.departmentCode],
      signature: true,
    })),
  );
  return bufferOf(bundle);
}

export async function departmentPdf(data: ExportData): Promise<Buffer> {
  const bundle = newDoc(data);
  renderSections(
    bundle.doc,
    data,
    'Department-wise Seating List',
    data.departments.map((dept) => ({
      heading: `Department ${dept.code}`,
      sub: dept.name,
      students: dept.students,
      cols: ROLL_COLS,
      cells: (s) => [s.rollNumber, s.studentName, s.roomNumber, s.benchNumber],
      signature: false,
    })),
  );
  return bufferOf(bundle);
}

export async function studentWisePdf(data: ExportData): Promise<Buffer> {
  const bundle = newDoc(data);
  const doc = bundle.doc;
  let y = pageHeader(doc, 'Student-wise Seating List (sorted by roll number)', data);
  y = tableHead(doc, ROLL_DEPT_COLS, y);
  for (const s of data.byRoll) {
    if (y + ROW_H > BOTTOM) {
      y = newPage(doc, 'Student-wise Seating List (continued)', data);
      y = tableHead(doc, ROLL_DEPT_COLS, y);
    }
    y = tableRow(doc, [s.rollNumber, s.studentName, s.departmentCode, s.roomNumber, s.benchNumber], ROLL_DEPT_COLS, y);
  }
  return bufferOf(bundle);
}

export async function planPdf(data: ExportData): Promise<Buffer> {
  const bundle = newDoc(data);
  const doc = bundle.doc;

  // Cover summary page.
  let y = pageHeader(doc, 'Complete Seating Plan — Summary', data);
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#0F172A').text(data.exam.subject, M, y + 6, { lineBreak: false });
  y += 36;
  const paper = data.exam.paperCode ? `Paper ${data.exam.paperCode}` : null;
  doc.font('Helvetica').fontSize(11).fillColor('#334155');
  doc.text(`Date: ${data.exam.date}    Time: ${data.exam.startTime} - ${data.exam.endTime}`, M, y, { lineBreak: false });
  if (paper) {
    y += 16;
    doc.text(paper, M, y, { lineBreak: false });
  }
  y += 26;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0F172A');
  doc.text(`Students seated: ${data.totals.students}`, M, y, { lineBreak: false });
  doc.text(`Rooms used: ${data.totals.rooms}`, M + 240, y, { lineBreak: false });
  y += 16;
  doc.text(`Total penalty: ${data.totalPenalty ?? '-'}`, M, y, { lineBreak: false });
  y += 16;
  doc.font('Helvetica').fontSize(9).fillColor('#64748B');
  doc.text(`Run generated: ${data.generatedAt.toISOString()}`, M, y, { lineBreak: false });
  y += 24;

  const summaryCols: Col[] = [
    { label: 'Room', width: 120 },
    { label: 'Building', width: 160 },
    { label: 'Floor', width: 100 },
    { label: 'Students', width: 131 },
  ];
  y = tableHead(doc, summaryCols, y);
  for (const room of data.rooms) {
    y = tableRow(doc, [room.roomNumber, room.building ?? '-', room.floor ?? '-', room.students.length], summaryCols, y);
  }

  // One page (or more) per room.
  for (const room of data.rooms) {
    const title = 'Classroom-wise Seating List';
    let ry = newPage(doc, title, data);
    ry = sectionTitle(doc, `Room ${room.roomNumber}`, roomSub(room), ry);
    ry = tableHead(doc, ROOM_COLS, ry);
    for (const s of room.students) {
      if (ry + ROW_H > BOTTOM) {
        ry = newPage(doc, `${title} (continued)`, data);
        ry = sectionTitle(doc, `Room ${room.roomNumber}`, roomSub(room), ry);
        ry = tableHead(doc, ROOM_COLS, ry);
      }
      ry = tableRow(doc, [s.benchNumber, s.rollNumber, s.studentName, s.departmentCode], ROOM_COLS, ry);
    }
    ry = signatureLine(doc, ry + 6);
  }

  return bufferOf(bundle);
}

function slipPayload(data: ExportData, seat: SlipSeat): SlipPayload {
  return {
    studentName: seat.studentName,
    rollNumber: seat.rollNumber,
    subject: data.exam.subject,
    paperCode: data.exam.paperCode,
    date: data.exam.date,
    startTime: data.exam.startTime,
    endTime: data.exam.endTime,
    roomNumber: seat.roomNumber,
    building: seat.building,
    floor: seat.floor,
    benchNumber: seat.benchNumber,
    publishedStamp: data.watermark ? null : shortStamp(data.publishedAt),
    generatedStamp: shortStamp(data.generatedAt) ?? '',
  };
}

export async function slipPdf(data: ExportData, seat: SlipSeat): Promise<Buffer> {
  const bundle = newDoc(data);
  drawSlip(bundle.doc, slipPayload(data, seat), { x: M + 30, y: 120, width: PAGE_W - 2 * (M + 30), height: 460 }, {
    footer: true,
    bordered: true,
  });
  return bufferOf(bundle);
}

const PER_PAGE = 6;
const COLS = 2;
const ROWS = 3;
const GRID_M = 24;
const GAP_X = 14;
const GAP_Y = 14;
const CELL_W = (PAGE_W - 2 * GRID_M - GAP_X) / COLS;
const CELL_H = (PAGE_H - 2 * GRID_M - GAP_Y * (ROWS - 1)) / ROWS;

export async function bulkSlipsPdf(data: ExportData, seats: SlipSeat[]): Promise<Buffer> {
  const bundle = newDoc(data);
  const doc = bundle.doc;
  for (let i = 0; i < seats.length; i++) {
    const index = i % PER_PAGE;
    if (index === 0 && i > 0) doc.addPage();
    const col = index % COLS;
    const row = Math.floor(index / COLS);
    const x = GRID_M + col * (CELL_W + GAP_X);
    const y = GRID_M + row * (CELL_H + GAP_Y);
    drawSlip(doc, slipPayload(data, seats[i]!), { x, y, width: CELL_W, height: CELL_H }, {
      footer: false,
      bordered: true,
    });
  }
  return bufferOf(bundle);
}
