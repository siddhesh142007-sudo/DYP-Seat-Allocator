import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Clock, DoorOpen, FileDown, Inbox, MapPin } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { formatExamDate, formatExamTime } from '../../lib/utils';

export interface PortalCard {
  examId: string;
  subject: string;
  paperCode: string | null;
  date: string;
  startTime: string;
  endTime: string;
  room: { roomNumber: string; building: string | null; floor: string | null };
  benchNumber: number;
  publishedAt: string | null;
}

export interface MySeatingResponse {
  upcoming: PortalCard[];
  past: PortalCard[];
}

function queryErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your session expired — please sign in again.';
    return err.message;
  }
  return 'Could not load your seating. Check your connection and try again.';
}

function roomLine(room: PortalCard['room']): string {
  return [room.building ? `Building ${room.building}` : null, room.floor ? `Floor ${room.floor}` : null]
    .filter(Boolean)
    .join(' · ');
}

function SlipButton({
  card,
  busy,
  error,
  onDownload,
}: {
  card: PortalCard;
  busy: boolean;
  error: string | null;
  onDownload: (examId: string) => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="primary"
        size="sm"
        loading={busy}
        onClick={() => onDownload(card.examId)}
        aria-label={`Download seating slip for ${card.subject}`}
      >
        <FileDown className="h-4 w-4" aria-hidden="true" />
        Download slip (PDF)
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

function UpcomingCard({
  card,
  busyId,
  downloadError,
  onDownload,
}: {
  card: PortalCard;
  busyId: string | null;
  downloadError: { examId: string; message: string } | null;
  onDownload: (examId: string) => void;
}) {
  return (
    <li className="rounded-xl border border-line bg-panel p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-ink">{card.subject}</h3>
            {card.paperCode && <Badge tone="brand">{card.paperCode}</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-muted">
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays className="h-4 w-4" aria-hidden="true" />
              {formatExamDate(card.date)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-4 w-4" aria-hidden="true" />
              {formatExamTime(card.startTime)} – {formatExamTime(card.endTime)}
            </span>
          </div>
        </div>
        <SlipButton
          card={card}
          busy={busyId === card.examId}
          error={downloadError?.examId === card.examId ? downloadError.message : null}
          onDownload={onDownload}
        />
      </div>

      <div className="mt-3 rounded-lg border border-brand-500 bg-brand-50 px-4 py-3">
        <div className="text-lg font-bold text-brand-700">
          Room: {card.room.roomNumber} / Bench: {card.benchNumber}
        </div>
        <div className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-brand-600">
          <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
          {roomLine(card.room) || 'Location to be confirmed'}
        </div>
      </div>
    </li>
  );
}

export function PortalPage() {
  const seatingQuery = useQuery({
    queryKey: ['my-seating'],
    queryFn: () => api.get<MySeatingResponse>('/me/seating'),
    retry: false,
  });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<{ examId: string; message: string } | null>(null);

  async function downloadSlip(examId: string): Promise<void> {
    setBusyId(examId);
    setDownloadError(null);
    try {
      const blob = await api.download(`/me/seating/slip/${examId}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `seating-slip-${examId}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError({
        examId,
        message: err instanceof ApiError ? err.message : 'Download failed — please try again.',
      });
    } finally {
      setBusyId(null);
    }
  }

  if (seatingQuery.isLoading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading your seating">
        {[0, 1].map((i) => (
          <div key={i} className="h-36 animate-pulse rounded-xl border border-line bg-panel" />
        ))}
      </div>
    );
  }

  if (seatingQuery.isError) {
    return (
      <div className="rounded-xl border border-line bg-panel p-6 text-center">
        <p className="text-sm text-ink">{queryErrorMessage(seatingQuery.error)}</p>
        <Button className="mt-4" onClick={() => void seatingQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const { upcoming, past } = seatingQuery.data ?? { upcoming: [], past: [] };

  if (upcoming.length === 0 && past.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-panel p-8 text-center">
        <Inbox className="mx-auto h-10 w-10 text-ink-muted" aria-hidden="true" />
        <h2 className="mt-3 text-base font-semibold text-ink">No seating published yet</h2>
        <p className="mx-auto mt-1 max-w-sm text-sm text-ink-muted">
          Your room and bench will appear here as soon as the exam cell publishes the seating plan.
          Check back closer to your exam date.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="upcoming-heading">
        <h2 id="upcoming-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Upcoming exams ({upcoming.length})
        </h2>
        {upcoming.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-panel p-6 text-center text-sm text-ink-muted">
            <DoorOpen className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
            No upcoming exams have a published seat yet.
          </div>
        ) : (
          <ul className="space-y-3">
            {upcoming.map((card) => (
              <UpcomingCard
                key={card.examId}
                card={card}
                busyId={busyId}
                downloadError={downloadError}
                onDownload={(id) => void downloadSlip(id)}
              />
            ))}
          </ul>
        )}
      </section>

      {past.length > 0 && (
        <section aria-labelledby="past-heading">
          <details className="rounded-xl border border-line bg-panel">
            <summary
              id="past-heading"
              className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-ink hover:text-brand-700"
            >
              Past exams ({past.length})
            </summary>
            <ul className="divide-y divide-line border-t border-line">
              {past.map((card) => (
                <li key={card.examId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-ink">{card.subject}</span>
                      {card.paperCode && <Badge tone="neutral">{card.paperCode}</Badge>}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-muted">
                      {formatExamDate(card.date)} · {formatExamTime(card.startTime)} –{' '}
                      {formatExamTime(card.endTime)} · Room {card.room.roomNumber} · Bench {card.benchNumber}
                    </div>
                  </div>
                  <SlipButton
                    card={card}
                    busy={busyId === card.examId}
                    error={downloadError?.examId === card.examId ? downloadError.message : null}
                    onDownload={downloadSlip}
                  />
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </div>
  );
}
