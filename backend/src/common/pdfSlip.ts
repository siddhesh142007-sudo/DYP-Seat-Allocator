import PDFDocument from 'pdfkit';

export type PdfDoc = InstanceType<typeof PDFDocument>;

export interface SlipPayload {
  studentName: string;
  rollNumber: string;
  subject: string;
  paperCode: string | null;
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'HH:mm' */
  startTime: string;
  /** 'HH:mm' */
  endTime: string;
  roomNumber: string;
  building: string | null;
  floor: string | null;
  benchNumber: number;
  /** pre-formatted publish stamp ('YYYY-MM-DD HH:mm') or null */
  publishedStamp: string | null;
  /** pre-formatted generation stamp ('YYYY-MM-DD HH:mm') */
  generatedStamp: string;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** 'YYYY-MM-DD' -> '10 September 2026' (parts parsed numerically: no TZ shift). */
export function prettyDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function shortStamp(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

function field(doc: PdfDoc, label: string, value: string, x: number, y: number, valueWidth: number, k: number): number {
  doc.font('Helvetica').fontSize(9 * k).fillColor('#666666').text(label, x, y, { width: 110 * k, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(12 * k).fillColor('#111111').text(value, x + 115 * k, y - 2 * k, {
    width: valueWidth,
    lineBreak: false,
  });
  return y + 20 * k;
}

/**
 * Draws one seating slip inside `box`. `k` scales the layout so the same
 * renderer fills a full page (single slip) or a cut-out cell (bulk, 6/A4).
 * Text strings are identical at every scale (tests decode them).
 */
export function drawSlip(
  doc: PdfDoc,
  p: SlipPayload,
  box: { x: number; y: number; width: number; height: number },
  opts: { footer?: boolean; bordered?: boolean } = {},
): void {
  const k = Math.min(1, box.height / 360);
  const { x, y, width } = box;

  if (opts.bordered !== false) {
    doc.roundedRect(x, y, width, box.height, 4).lineWidth(1).strokeColor('#94A3B8').stroke();
  }

  let cy = y + 12 * k;
  doc
    .font('Helvetica-Bold')
    .fontSize(16 * k)
    .fillColor('#111111')
    .text('EXAM SEATING SLIP', x + 14 * k, cy, { width: width - 28 * k, align: 'center', lineBreak: false });
  cy += 22 * k;
  doc
    .moveTo(x + 14 * k, cy)
    .lineTo(x + width - 14 * k, cy)
    .strokeColor('#999999')
    .lineWidth(1)
    .stroke();
  cy += 12 * k;

  const vx = x + 14 * k;
  const valueWidth = width - 155 * k;
  cy = field(doc, 'Student', p.studentName, vx, cy, valueWidth, k);
  cy = field(doc, 'Roll number', p.rollNumber, vx, cy, valueWidth, k);
  cy = field(doc, 'Subject', p.subject, vx, cy, valueWidth, k);
  cy = field(doc, 'Paper code', p.paperCode ?? '—', vx, cy, valueWidth, k);
  cy = field(doc, 'Date', prettyDate(p.date), vx, cy, valueWidth, k);
  cy = field(doc, 'Time', `${p.startTime} – ${p.endTime}`, vx, cy, valueWidth, k);

  cy += 8 * k;
  const boxH = 54 * k;
  doc.roundedRect(x + 14 * k, cy, width - 28 * k, boxH, 6).fillColor('#EEF2FF').fill();
  doc
    .font('Helvetica-Bold')
    .fontSize(15 * k)
    .fillColor('#1E3A8A')
    .text(`Room: ${p.roomNumber}   /   Bench: ${p.benchNumber}`, x + 26 * k, cy + 9 * k, {
      width: width - 52 * k,
      lineBreak: false,
    });
  const roomParts = [
    `Room ${p.roomNumber}`,
    p.building ? `Building ${p.building}` : null,
    p.floor ? `Floor ${p.floor}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  doc.font('Helvetica').fontSize(10 * k).fillColor('#334155').text(roomParts, x + 26 * k, cy + 33 * k, {
    width: width - 52 * k,
    lineBreak: false,
  });
  cy += boxH + 14 * k;

  if (opts.footer) {
    if (p.publishedStamp) {
      cy = field(doc, 'Published', p.publishedStamp, vx, cy, valueWidth, k);
    }
    cy = field(doc, 'Generated', p.generatedStamp, vx, cy, valueWidth, k);
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor('#666666')
      .text(
        'Carry your college ID card along with this slip. Report to the room above at least 15 minutes before the start time.',
        x + 14 * k,
        cy + 8,
        { width: width - 28 * k },
      );
  }
}
