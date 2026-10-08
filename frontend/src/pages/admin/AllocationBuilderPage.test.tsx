// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../components/ui/Toast';
import { AllocationBuilderPage } from './AllocationBuilderPage';
import { setSession, clearSession } from '../../api/authStore';

const EXAM_ID = '11111111-1111-4111-8111-111111111111';
const ROOM_ID = '22222222-2222-4222-8222-222222222222';

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob(),
  };
}

const COHORTS = {
  cohorts: [{ yearCode: 'SE', branchCode: 'AIDS', division: 'C', count: 30, minSerial: 1, maxSerial: 30 }],
};

const ROOMS = {
  items: [{ id: ROOM_ID, roomNumber: '706', building: 'B', floor: '7', availableSeats: 60 }],
};

const EXAM = { exam: { id: EXAM_ID, subject: 'Data Structures', paperCode: 'CS201', examDate: '2026-12-01' } };

const ONE_INTENT = {
  id: 'i1',
  classroomId: ROOM_ID,
  roomNumber: '706',
  floor: '7',
  yearCode: 'SE',
  branchCode: 'AIDS',
  division: 'C',
  fromSerial: 1,
  toSerial: 20,
  rowCount: null,
  colCount: null,
  seatOffset: 1,
  strictRollOrder: false,
  studentCount: 20,
  availableBenches: 60,
};

function renderBuilder() {
  return render(
    <MemoryRouter initialEntries={[`/admin/exams/${EXAM_ID}/seating/builder`]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <Routes>
            <Route path="/admin/exams/:examId/seating/builder" element={<AllocationBuilderPage />} />
            <Route path="/admin/exams/:examId/seating" element={<div>seating-page</div>} />
          </Routes>
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** Routes the mocked API: four GETs, the intents POST and the generate POST. */
function mockApi(intents: unknown[] = [], postStatus = 201) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.includes('/dypit/cohorts')) return Promise.resolve(jsonResponse(200, COHORTS));
    if (u.includes('/classrooms?')) return Promise.resolve(jsonResponse(200, ROOMS));
    if (u.includes('generate-from-intents')) {
      return Promise.resolve(jsonResponse(200, { result: { runId: 'r1', totalSeated: 20, totalPenalty: 12 } }));
    }
    if (u.includes('/intents/explain')) {
      return Promise.resolve(jsonResponse(200, { totalStudents: 20, blocks: [], examId: EXAM_ID }));
    }
    if (u.endsWith('/intents') && method === 'POST') {
      return postStatus === 201
        ? Promise.resolve(jsonResponse(201, { intent: ONE_INTENT }))
        : Promise.resolve(
            jsonResponse(422, {
              error: {
                code: 'UNPROCESSABLE_ENTITY',
                message: 'Room 706 has 5 usable bench(es) but this block needs 20',
                details: { code: 'ROOM_TOO_SMALL' },
              },
            }),
          );
    }
    if (u.endsWith('/intents')) return Promise.resolve(jsonResponse(200, { intents }));
    if (u.includes(`/api/v1/exams/${EXAM_ID}`)) return Promise.resolve(jsonResponse(200, EXAM));
    return Promise.resolve(jsonResponse(404, null));
  });
}

function postedIntents() {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).endsWith('/intents') && (c[1]?.method ?? 'GET') === 'POST')
    .map((c) => JSON.parse(String(c[1]?.body)));
}

/** Waits until the cohort options have loaded before selecting one. */
async function selectCohort() {
  const select = (await screen.findByLabelText(/year \/ branch \/ division/i)) as HTMLSelectElement;
  await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: 'SE|AIDS|C' } });
}

async function fillValidForm(strict = false) {
  await selectCohort();
  fireEvent.change(screen.getByLabelText(/^classroom/i), { target: { value: ROOM_ID } });
  fireEvent.change(screen.getByLabelText(/from serial/i), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText(/to serial/i), { target: { value: '20' } });
  if (strict) fireEvent.click(screen.getByLabelText(/strict roll order/i));
  fireEvent.click(screen.getByRole('button', { name: /add block/i }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  clearSession();
  setSession({
    user: {
      id: 'a1',
      name: 'Admin',
      email: 'a@t.local',
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      studentId: null,
      mustChangePassword: false,
    },
    accessToken: 't',
    expiresAt: Date.now() + 600_000,
  });
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AllocationBuilderPage', () => {
  it('renders cohort and classroom pickers populated from the API', async () => {
    mockApi();
    renderBuilder();
    const cohortSelect = (await screen.findByLabelText(/year \/ branch \/ division/i)) as HTMLSelectElement;
    await waitFor(() => expect(cohortSelect.options.length).toBeGreaterThan(1));
    expect(cohortSelect.options[1]?.textContent).toContain('SE · AIDS · C');
    expect(screen.getByLabelText(/^classroom/i)).toBeTruthy();
  });

  it('shows an empty state and zero totals when nothing is planned', async () => {
    mockApi([]);
    renderBuilder();
    expect(await screen.findByText(/No blocks yet/)).toBeTruthy();
    expect(screen.getByText('Blocks planned').nextElementSibling?.textContent).toBe('0');
  });

  it('lists a planned block with its range, room and student count', async () => {
    mockApi([ONE_INTENT]);
    renderBuilder();
    expect(await screen.findByText('SE-AIDS-C_01 → SE-AIDS-C_20')).toBeTruthy();
    expect(screen.getByText('Students planned').nextElementSibling?.textContent).toBe('20');
    expect(screen.getByText('Rooms used').nextElementSibling?.textContent).toBe('1');
  });

  it('requires a cohort before submitting', async () => {
    mockApi();
    renderBuilder();
    await screen.findByLabelText(/year \/ branch \/ division/i);
    fireEvent.click(screen.getByRole('button', { name: /add block/i }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent');
    expect((await screen.findByRole('alert')).textContent).toMatch(/year, branch and division/i);
    expect(postedIntents()).toHaveLength(0);
  });

  it('rejects an inverted serial range client-side', async () => {
    mockApi();
    renderBuilder();
    await selectCohort();
    fireEvent.change(screen.getByLabelText(/^classroom/i), { target: { value: ROOM_ID } });
    fireEvent.change(screen.getByLabelText(/from serial/i), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText(/to serial/i), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /add block/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/at or after the from serial/i);
    expect(postedIntents()).toHaveLength(0);
  });

  it('submits the parsed cohort parts for a valid block', async () => {
    mockApi();
    renderBuilder();
    await fillValidForm();
    await waitFor(() => expect(postedIntents()).toHaveLength(1));
    expect(postedIntents()[0]).toMatchObject({
      classroomId: ROOM_ID,
      yearCode: 'SE',
      branchCode: 'AIDS',
      division: 'C',
      fromSerial: 1,
      toSerial: 20,
      strictRollOrder: false,
    });
  });

  it('sends strictRollOrder when the checkbox is ticked', async () => {
    mockApi();
    renderBuilder();
    await fillValidForm(true);
    await waitFor(() => expect(postedIntents()).toHaveLength(1));
    expect(postedIntents()[0].strictRollOrder).toBe(true);
  });

  it('requires both grid dimensions together', async () => {
    mockApi();
    renderBuilder();
    await selectCohort();
    fireEvent.change(screen.getByLabelText(/^classroom/i), { target: { value: ROOM_ID } });
    fireEvent.change(screen.getByLabelText(/from serial/i), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(/to serial/i), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Rows (optional)'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /add block/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/both rows and columns/i);
    expect(postedIntents()).toHaveLength(0);
  });

  it('sends the grid when both dimensions are given', async () => {
    mockApi();
    renderBuilder();
    await selectCohort();
    fireEvent.change(screen.getByLabelText(/^classroom/i), { target: { value: ROOM_ID } });
    fireEvent.change(screen.getByLabelText(/from serial/i), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(/to serial/i), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Rows (optional)'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Columns (optional)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /add block/i }));
    await waitFor(() => expect(postedIntents()).toHaveLength(1));
    expect(postedIntents()[0]).toMatchObject({ rowCount: 4, colCount: 5 });
  });

  it('surfaces the structured reason when a block is rejected', async () => {
    mockApi([], 422);
    renderBuilder();
    await fillValidForm();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/ROOM_TOO_SMALL/);
    expect(alert.textContent).toMatch(/needs 20/);
  });

  it('generates with replace=true and reports the outcome', async () => {
    mockApi([ONE_INTENT]);
    renderBuilder();
    await screen.findByText('SE-AIDS-C_01 → SE-AIDS-C_20');
    fireEvent.click(screen.getByRole('button', { name: /generate plan/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => String(c[0]).includes('generate-from-intents'));
      expect(post).toBeDefined();
      expect(JSON.parse(String(post![1]?.body))).toEqual({ replace: true });
    });
    expect(await screen.findByText(/Plan generated: 20 students seated/)).toBeTruthy();
  });

  it('disables Generate while there are no blocks', async () => {
    mockApi([]);
    renderBuilder();
    await screen.findByText(/No blocks yet/);
    expect((screen.getByRole('button', { name: /generate plan/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});