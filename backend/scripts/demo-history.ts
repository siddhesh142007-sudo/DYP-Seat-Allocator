/* eslint-disable no-console, @typescript-eslint/no-unused-vars */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const API_BASE = 'http://localhost:3001';
const DEMO_PASSWORD = 'Demo123!';

async function login(email: string) {
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: email, password: DEMO_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed for ${email}`);
  return (await res.json()).accessToken;
}

async function generateAndPublish(examId: string, seed: string, label: string, token: string) {
  console.log(`🔧 Generating ${label} (seed: ${seed})...`);

  const generateRes = await fetch(`${API_BASE}/api/v1/seating/exams/${examId}/generate-seating`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ mode: 'MIXED', historyDepth: 3, seed }),
  });
  if (!generateRes.ok) {
    const err = await generateRes.json();
    console.error(`  ✗ Generation failed: ${err.error?.code} — ${err.error?.message}`);
    if (err.error?.details) console.error(`     Details: ${JSON.stringify(err.error.details)}`);
    return;
  }
  const data = await generateRes.json();
  const run = data.result.run;
  console.log(`  ✓ Generated: ${run.allocationCount} seated, penalty ${run.penalty}, ${run.timing.totalMs}ms`);

  // Publish
  const publishRes = await fetch(`${API_BASE}/api/v1/seating/exams/${examId}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  if (!publishRes.ok) {
    const err = await publishRes.json();
    console.error(`  ✗ Publish failed: ${err.error?.message}`);
    return;
  }
  console.log(`  ✓ Published (run ${run.id.slice(0, 8)})`);
}

async function main() {
  console.log('📚 Seeding demo history (Paper 1 + Paper 2)...');

  // Find exams by paper code
  const exams = await prisma.exam.findMany({
    where: { paperCode: { in: ['CS201', 'CS202'] } },
    orderBy: { examDate: 'asc' },
  });

  if (exams.length < 2) {
    console.error('Expected CS201 and CS202 exams; run seed:demo first');
    process.exit(1);
  }

  // Login as exam admin
  let token: string;
  try {
    token = await login('examadmin@demo.local');
  } catch (e) {
    console.log('\n⚠ Could not login to backend — is it running? Start with `npm run dev` in backend/');
    console.log('   Then re-run this script to generate history.');
    process.exit(0);
  }

  await generateAndPublish(exams[0].id, 'demo-paper-1', 'Data Structures (Paper 1)', token);
  await generateAndPublish(exams[1].id, 'demo-paper-2', 'DBMS (Paper 2)', token);
  console.log('\n✓ Demo history seeded. Run Paper 3 live to demonstrate reshuffling.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });