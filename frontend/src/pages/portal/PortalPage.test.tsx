// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PortalPage, type MySeatingResponse, type PortalCard } from './PortalPage';

const apiGet = vi.fn();
const apiDownload = vi.fn();

vi.mock('../../api/client', () => ({
  API_BASE: '',
  api: {
    get: (path: string) => apiGet(path),
    download: (path: string) => apiDownload(path),
  },
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    details: unknown;
    constructor(status: number, code: string, message: string, details: unknown = null) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  },
}));

function makeCard(overrides: Partial<PortalCard> = {}): PortalCard {
  return {
    examId: '11111111-1111-1111-1111-111111111111',
    subject: 'Data Structures',
    paperCode: 'CS-201',
    date: '2026-10-20',
    startTime: '10:00',
    endTime: '13:00',
    room: { roomNumber: '103', building: 'A', floor: '2' },
    benchNumber: 17,
    publishedAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PortalPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiDownload.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('PortalPage', () => {
  it('shows an empty state when nothing is published', async () => {
    apiGet.mockResolvedValue({ upcoming: [], past: [] } satisfies MySeatingResponse);
    renderPage();
    expect(await screen.findByText('No seating published yet')).toBeTruthy();
    expect(screen.getByText(/room and bench will appear here/i)).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith('/me/seating');
  });

  it('renders upcoming exam cards with subject, paper code, date, time and the Room/Bench highlight', async () => {
    apiGet.mockResolvedValue({ upcoming: [makeCard()], past: [] } satisfies MySeatingResponse);
    renderPage();

    expect(await screen.findByText('Data Structures')).toBeTruthy();
    expect(screen.getByText('CS-201')).toBeTruthy();
    expect(screen.getByText('20 October 2026')).toBeTruthy();
    expect(screen.getByText('10:00 AM – 1:00 PM')).toBeTruthy();
    expect(screen.getByText('Room: 103 / Bench: 17')).toBeTruthy();
    expect(screen.getByText('Building A · Floor 2')).toBeTruthy();
  });

  it('lists past exams in a collapsed section', async () => {
    apiGet.mockResolvedValue({
      upcoming: [],
      past: [makeCard({ examId: '22222222-2222-2222-2222-222222222222', subject: 'Old Subject', date: '2020-01-15' })],
    } satisfies MySeatingResponse);
    renderPage();

    const summary = await screen.findByText('Past exams (1)');
    expect(summary).toBeTruthy();
    const details = summary.closest('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);

    fireEvent.click(summary);
    expect(details!.open).toBe(true);
    expect(screen.getByText('Old Subject')).toBeTruthy();
  });

  it('downloads the slip for an exam card', async () => {
    apiGet.mockResolvedValue({ upcoming: [makeCard()], past: [] } satisfies MySeatingResponse);
    apiDownload.mockResolvedValue(new Blob(['%PDF-1.3'], { type: 'application/pdf' }));
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    renderPage();
    const button = await screen.findByRole('button', { name: /download seating slip/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(apiDownload).toHaveBeenCalledWith('/me/seating/slip/11111111-1111-1111-1111-111111111111');
    });
    expect(createObjectURL).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('surfaces a download failure inline', async () => {
    apiGet.mockResolvedValue({ upcoming: [makeCard()], past: [] } satisfies MySeatingResponse);
    apiDownload.mockRejectedValue(new (await import('../../api/client')).ApiError(404, 'NOT_FOUND', 'No published seating found for this exam'));

    renderPage();
    const button = await screen.findByRole('button', { name: /download seating slip/i });
    fireEvent.click(button);

    expect(await screen.findByText('No published seating found for this exam')).toBeTruthy();
  });

  it('shows an error state with retry when loading fails', async () => {
    apiGet.mockRejectedValue(new Error('network down'));
    renderPage();
    expect(await screen.findByText('Could not load your seating. Check your connection and try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
