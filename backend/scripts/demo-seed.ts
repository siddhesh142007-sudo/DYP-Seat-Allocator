/* eslint-disable no-console, @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */
import { PrismaClient, Role, ExamStatus, SeatingStatus, ClassroomStatus, SeatStatus, StudentStatus } from '@prisma/client';
import { hashPassword } from '../src/modules/auth/auth.utils.js';

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'Demo123!';

async function createUser(email: string, role: Role, studentId?: string, name?: string) {
  const pwHash = await hashPassword(DEMO_PASSWORD);
  return prisma.user.create({
    data: { email, passwordHash: pwHash, role, studentId, name: name ?? email.split('@')[0] },
  });
}

async function main() {
  console.log('🌱 Seeding demo data...');

  // Clear existing data (reverse dependency order) using bypass for immutability
  await prisma.$transaction(async (tx) => {
    // Enable bypass for published immutability
    await tx.$executeRawUnsafe(`SELECT allow_published_mutation()`);
    // Unpublish all runs to bypass immutability trigger
    await tx.seatingRun.updateMany({ where: { status: 'PUBLISHED' }, data: { status: 'VALIDATED', publishedAt: null, publishedBy: null } });
    await tx.exam.updateMany({ where: { seatingStatus: 'PUBLISHED' }, data: { seatingStatus: 'VALIDATED' } });
    await tx.seatingAllocation.deleteMany();
    await tx.seatingRun.deleteMany();
    await tx.auditLog.deleteMany();
    await tx.examRegistration.deleteMany();
    await tx.exam.deleteMany();
    await tx.seat.deleteMany();
    await tx.classroom.deleteMany();
    await tx.student.deleteMany();
    await tx.user.deleteMany();
    await tx.department.deleteMany();
    await tx.academicYear.deleteMany();
  });

  // --- Academic Years ---
  const ay1 = await prisma.academicYear.create({ data: { name: '2023–24', code: '2023-24' } });
  const ay2 = await prisma.academicYear.create({ data: { name: '2024–25', code: '2024-25' } });
  const ay3 = await prisma.academicYear.create({ data: { name: '2025–26', code: '2025-26' } });
  const ay4 = await prisma.academicYear.create({ data: { name: '2026–27', code: '2026-27' } });
  console.log('✓ Academic years created');

  // --- Departments ---
  const depts = await Promise.all([
    prisma.department.create({ data: { name: 'Computer Science & Engineering', code: 'CSE' } }),
    prisma.department.create({ data: { name: 'Artificial Intelligence & Data Science', code: 'AIDS' } }),
    prisma.department.create({ data: { name: 'Electronics & Communication', code: 'ECE' } }),
    prisma.department.create({ data: { name: 'Mechanical Engineering', code: 'MECH' } }),
    prisma.department.create({ data: { name: 'Civil Engineering', code: 'CIVIL' } }),
    prisma.department.create({ data: { name: 'Electrical Engineering', code: 'EE' } }),
  ]);
  const [cse, aids, ece, mech, civil, ee] = depts;
  console.log('✓ Departments created');

  // --- Classrooms (15 rooms, mix of capacities, some unavailable, some disabled benches) ---
  const roomDefs = [
    { num: '101', cap: 30, bldg: 'A', floor: '1', status: 'AVAILABLE' },
    { num: '102', cap: 40, bldg: 'A', floor: '1', status: 'AVAILABLE' },
    { num: '103', cap: 25, bldg: 'A', floor: '1', status: 'AVAILABLE' },
    { num: '104', cap: 50, bldg: 'A', floor: '2', status: 'AVAILABLE' },
    { num: '105', cap: 35, bldg: 'A', floor: '2', status: 'AVAILABLE' },
    { num: '106', cap: 28, bldg: 'B', floor: '1', status: 'AVAILABLE' },
    { num: '107', cap: 30, bldg: 'B', floor: '1', status: 'AVAILABLE' },
    { num: '108', cap: 45, bldg: 'B', floor: '2', status: 'AVAILABLE' },
    { num: '109', cap: 25, bldg: 'B', floor: '2', status: 'AVAILABLE' },
    { num: '110', cap: 40, bldg: 'C', floor: '1', status: 'UNAVAILABLE' },
    { num: '111', cap: 30, bldg: 'C', floor: '1', status: 'AVAILABLE' },
    { num: '112', cap: 50, bldg: 'C', floor: '2', status: 'AVAILABLE' },
    { num: '113', cap: 35, bldg: 'C', floor: '2', status: 'AVAILABLE' },
    { num: '114', cap: 28, bldg: 'D', floor: '1', status: 'AVAILABLE' },
    { num: '115', cap: 30, bldg: 'D', floor: '1', status: 'UNAVAILABLE' },
  ];

  const rooms: Array<{ id: string; capacity: number }> = [];
  for (const d of roomDefs) {
    const room = await prisma.classroom.create({
      data: {
        roomNumber: d.num,
        building: d.bldg,
        floor: d.floor,
        status: d.status as ClassroomStatus,
        capacity: d.cap,
      },
    });
    rooms.push({ id: room.id, capacity: d.cap });
    // Generate benches
    await prisma.seat.createMany({
      data: Array.from({ length: d.cap }, (_, i) => ({
        classroomId: room.id,
        benchNumber: i + 1,
        status: 'AVAILABLE' as SeatStatus,
        rowNo: i + 1,
        colNo: 1,
      })),
    });
    // Disable a few benches in rooms 103, 107, 112
    if (['103', '107', '112'].includes(d.num)) {
      const seatsToDisable = Math.max(1, Math.floor(d.cap / 10));
      const seats = await prisma.seat.findMany({
        where: { classroomId: room.id },
        take: seatsToDisable,
        orderBy: { benchNumber: 'asc' },
      });
      await prisma.seat.updateMany({
        where: { id: { in: seats.map((s) => s.id) } },
        data: { status: 'DISABLED' as SeatStatus },
      });
    }
  }
  console.log(`✓ ${rooms.length} classrooms with benches created`);

  // --- Admin Users ---
  const superAdmin = await createUser('admin@demo.local', 'SUPER_ADMIN');
  const examAdmin = await createUser('examadmin@demo.local', 'EXAM_ADMIN');
  console.log('✓ Admin users created');

  // --- Student names (Indian, realistic) ---
  const firstNames = [
    'Aarav', 'Vihaan', 'Aditya', 'Arjun', 'Krishna', 'Rohan', 'Kabir', 'Ishaan', 'Vivaan', 'Ayaan',
    'Anaya', 'Diya', 'Ira', 'Kiara', 'Myra', 'Navya', 'Saisha', 'Tara', 'Zara', 'Riya',
    'Ayaan', 'Dev', 'Rudra', 'Atharv', 'Dhruv', 'Reyansh', 'Veer', 'Om', 'Yash', 'Neil',
    'Aadhya', 'Anika', 'Arya', 'Kavya', 'Prisha', 'Ria', 'Saanvi', 'Shreya', 'Tanya', 'Zoya',
  ];
  const lastNames = [
    'Sharma', 'Patel', 'Singh', 'Kumar', 'Gupta', 'Reddy', 'Nair', 'Iyer', 'Rao', 'Joshi',
    'Mehta', 'Desai', 'Chopra', 'Malhotra', 'Bhatia', 'Chauhan', 'Yadav', 'Verma', 'Saxena', 'Tiwari',
  ];

  function rollNumber(year: string, deptCode: string, idx: number): string {
    return `${year}${deptCode}${String(idx).padStart(3, '0')}`;
  }

  function randomName(): string {
    return `${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}`;
  }

  // --- Students: 2nd Year (AY 2024-25) - 370 students ---
  const year2 = ay2;

  const studentIds: string[] = [];

  async function createStudentsBatch(students: Array<{
    rollNumber: string; name: string; email: string; division: string;
    departmentId: string; academicYearId: string;
  }>) {
    await prisma.student.createMany({ data: students });
  }

  // 2nd Year students
  const year2Students: Array<any> = [];
  for (let i = 1; i <= 120; i++) {
    const rn = rollNumber('24', 'CSE', i);
    year2Students.push({
      rollNumber: rn, name: randomName(), email: `${rn.toLowerCase()}@student.demo`,
      division: i <= 60 ? 'A' : 'B', departmentId: cse.id, academicYearId: year2.id,
      status: 'ACTIVE' as StudentStatus,
    });
  }
  for (let i = 1; i <= 100; i++) {
    const rn = rollNumber('24', 'AIDS', i);
    year2Students.push({
      rollNumber: rn, name: randomName(), email: `${rn.toLowerCase()}@student.demo`,
      division: 'A', departmentId: aids.id, academicYearId: year2.id,
      status: 'ACTIVE' as StudentStatus,
    });
  }
  for (let i = 1; i <= 80; i++) {
    const rn = rollNumber('24', 'ECE', i);
    year2Students.push({
      rollNumber: rn, name: randomName(), email: `${rn.toLowerCase()}@student.demo`,
      division: 'B', departmentId: ece.id, academicYearId: year2.id,
      status: 'ACTIVE' as StudentStatus,
    });
  }
  for (let i = 1; i <= 70; i++) {
    const rn = rollNumber('24', 'MECH', i);
    year2Students.push({
      rollNumber: rn, name: randomName(), email: `${rn.toLowerCase()}@student.demo`,
      division: 'C', departmentId: mech.id, academicYearId: year2.id,
      status: 'ACTIVE' as StudentStatus,
    });
  }
  await createStudentsBatch(year2Students);
  const year2StudentRows = await prisma.student.findMany({ where: { academicYearId: year2.id }, select: { id: true } });
  year2StudentRows.forEach(s => studentIds.push(s.id));
  console.log(`✓ ${year2StudentRows.length} 2nd Year students created`);

  // --- Smaller sets for other years ---
  // 1st Year (AY 2025-26) ~ 80
  const year1Students: Array<any> = [];
  for (const [dept, count] of [[cse, 30], [aids, 20], [ece, 15], [mech, 15]] as const) {
    for (let i = 1; i <= count; i++) {
      const rn = rollNumber('25', dept.code, i);
      year1Students.push({
        rollNumber: rn, name: randomName(), email: `${rn.toLowerCase()}@student.demo`,
        division: 'A', departmentId: dept.id, academicYearId: ay3.id,
        status: 'ACTIVE' as StudentStatus,
      });
    }
  }
  await createStudentsBatch(year1Students);
  const y1Rows = await prisma.student.findMany({ where: { academicYearId: ay3.id }, select: { id: true } });
  y1Rows.forEach(s => studentIds.push(s.id));

  // 3rd Year (AY 2023-24) ~ 100
  const year3Students: Array<any> = [];
  for (const [dept, count] of [[cse, 35], [aids, 25], [ece, 20], [mech, 20]] as const) {
    for (let i = 1; i <= count; i++) {
      const rn = rollNumber('23', dept.code, i);
      year3Students.push({
        rollNumber: rn, name: randomName(), email: `${rn.toLowerCase()}@student.demo`,
        division: 'A', departmentId: dept.id, academicYearId: ay1.id,
        status: 'ACTIVE' as StudentStatus,
      });
    }
  }
  await createStudentsBatch(year3Students);
  const y3Rows = await prisma.student.findMany({ where: { academicYearId: ay1.id }, select: { id: true } });
  y3Rows.forEach(s => studentIds.push(s.id));

  // 4th Year (AY 2022-23) ~ 60
  const year4Students: Array<any> = [];
  for (const [dept, count] of [[cse, 20], [aids, 15], [ece, 15], [mech, 10]] as const) {
    for (let i = 1; i <= count; i++) {
      const rn = rollNumber('22', dept.code, i);
      year4Students.push({
        rollNumber: rn, name: randomName(), email: `${rn.toLowerCase()}@student.demo`,
        division: 'A', departmentId: dept.id, academicYearId: ay4.id,
        status: 'ACTIVE' as StudentStatus,
      });
    }
  }
  await createStudentsBatch(year4Students);
  const y4Rows = await prisma.student.findMany({ where: { academicYearId: ay4.id }, select: { id: true } });
  y4Rows.forEach(s => studentIds.push(s.id));

  console.log(`✓ Total ${studentIds.length} students created`);

  // --- Exams ---
  // 2nd Year exams (AY 2024-25)
  const dsExam = await prisma.exam.create({
    data: {
      subject: 'Data Structures',
      paperCode: 'CS201',
      semester: 4,
      examDate: new Date('2025-12-10'),
      startTime: new Date('2000-01-01T09:00:00'),
      endTime: new Date('2000-01-01T12:00:00'),
      academicYearId: year2.id,
      status: 'PLANNED' as ExamStatus,
      seatingStatus: 'NOT_GENERATED' as SeatingStatus,
    },
  });
  const dbmsExam = await prisma.exam.create({
    data: {
      subject: 'Database Management Systems',
      paperCode: 'CS202',
      semester: 4,
      examDate: new Date('2025-12-12'),
      startTime: new Date('2000-01-01T09:00:00'),
      endTime: new Date('2000-01-01T12:00:00'),
      academicYearId: year2.id,
      status: 'PLANNED' as ExamStatus,
      seatingStatus: 'NOT_GENERATED' as SeatingStatus,
    },
  });
  const osExam = await prisma.exam.create({
    data: {
      subject: 'Operating Systems',
      paperCode: 'CS203',
      semester: 4,
      examDate: new Date('2025-12-14'),
      startTime: new Date('2000-01-01T09:00:00'),
      endTime: new Date('2000-01-01T12:00:00'),
      academicYearId: year2.id,
      status: 'PLANNED' as ExamStatus,
      seatingStatus: 'NOT_GENERATED' as SeatingStatus,
    },
  });
  // 3rd Year exam overlapping with DS (clash)
  const aiExam = await prisma.exam.create({
    data: {
      subject: 'Artificial Intelligence',
      paperCode: 'CS301',
      semester: 6,
      examDate: new Date('2025-12-10'),
      startTime: new Date('2000-01-01T09:00:00'),
      endTime: new Date('2000-01-01T12:00:00'),
      academicYearId: ay1.id,
      status: 'PLANNED' as ExamStatus,
      seatingStatus: 'NOT_GENERATED' as SeatingStatus,
    },
  });
  console.log('✓ Exams created');

  // --- Print demo credentials ---
  console.log('\n=== DEMO CREDENTIALS (DEV ONLY) ===');
  console.log('Super Admin:    admin@demo.local / Demo123!');
  console.log('Exam Admin:     examadmin@demo.local / Demo123!');
  console.log('Student logins: disabled (administrator-only deployment)');
  console.log('====================================\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });