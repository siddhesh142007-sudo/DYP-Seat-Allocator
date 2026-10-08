import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Eye,
  RefreshCw,
  Send,
  Undo2,
  Wand2,
  XCircle,
} from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../features/auth/AuthContext';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { statusTone, seatingStatusTone, type BadgeTone } from '../../components/ui/tones';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Modal } from '../../components/ui/Modal';
import { FormField, Input, Select, Textarea } from '../../components/ui/FormField';
import { ExportMenu } from '../../components/ExportMenu';
import { useToast } from '../../components/ui/toastContext';
import type { ExamRow } from './ExamsPage';

interface ExamDetail extends ExamRow {
  registrationCounts: Record<string, number>;
  eligibleCount: number;
}

interface Conflict {
  code: string;
  message: string;
  details?: {
    exams?: Array<{ id: string; subject: string; examDate: string; startTime: string; endTime: string; hasSeatingPlan: boolean; blockedRooms: number }>;
    eligibleCount?: number;
    availableSeats?: number;
    shortfall?: number;
    availableRooms?: number;
    blockedRooms?: number;
  };
}

interface PreviewStats {
  examId: string;
  eligibleCount: number;
  availableSeats: number;
  availableRooms: number;
  classroomsRequired: number;
  departmentsBreakdown: Array<{ code: string; name: string; count: number }>;
  roomsBlockedByOtherExams: {
    count: number;
    rooms: Array<{ classroomId: string; roomNumber: string | null; blockingSubject: string | null }>;
  };
  conflicts: Conflict[];
}

interface ValidationReport {
  status: 'VALID' | 'INVALID';
  students: number;
  assigned: number;
  unassigned: number;
  seatsUsed: number;
  duplicateSeats: string[];
  duplicateStudents: string[];
  capacityViolations: string[];
  ineligibleIncluded: string[];
  unavailableSeatUsed: string[];
  roomPerSeatMismatch: string[];
  historyConsidered: { enabled: boolean; depth: number };
  violations: Array<{ code: string; message: string }>;
}

interface RunStats {
  sameSeatAsPrev: number;
  sameRoomAsPrev: number;
  sameBenchNoAsPrev: number;
  sameNeighbourAsPrev: number;
  sameDeptAdjacent: number;
  timeMs: number;
  iterations: number;
}

interface Run {
  id: string;
  status: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'FAILED' | 'SUPERSEDED';
  seed: string;
  stats: RunStats | null;
  validationReport: ValidationReport | null;
  totalPenalty: number | null;
  generatedAt: string;
  publishedAt: string | null;
  algorithmVersion: string;
}

interface GenerateResponse {
  result: {
    run: Run & {
      penalty: number;
      timing: { totalMs: number; allocateMs: number; improveMs: number; validateMs: number };
    };
  };
}

interface StaleReport {
  runId: string;
  runStatus: string;
  status: 'VALID' | 'STALE';
  eligibleCount: number;
  seatedCount: number;
  addedAfterGeneration: Array<{ studentId: string; rollNumber: string; name: string }>;
  removedButSeated: Array<{ studentId: string; rollNumber: string; name: string }>;
  disabledRooms: Array<{ classroomId: string; roomNumber: string; status: string }>;
  disabledSeats: Array<{ seatId: string; classroomId: string }>;
  suggestion: string | null;
}

interface RunRow extends Run {
  allocationCount: number;
  failure: { code: string; message: string } | null;
}

interface ClassroomOption {
  id: string;
  roomNumber: string;
  building: string | null;
  status: string;
  totalSeats: number;
  availableSeats: number;
}

interface GenerateOptions {
  mode: 'MIXED' | 'BLOCK';
  seed: string;
  historyDepth: string;
  roomIds: string[];
}

const EMPTY_OPTIONS: GenerateOptions = { mode: 'MIXED', seed: '', historyDepth: '3', roomIds: [] };

const INFEASIBLE_CODES = new Set(['INSUFFICIENT_SEATS', 'NO_AVAILABLE_ROOMS', 'NO_ELIGIBLE_STUDENTS']);

const RUN_TONES: Record<Run['status'], BadgeTone> = {
  DRAFT: 'warning',
  VALIDATED: 'brand',
  PUBLISHED: 'success',
  FAILED: 'danger',
  SUPERSEDED: 'neutral',
};

function StatTile({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-canvas p-3">
      <dt className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</dt>
      <dd className="mt-1 text-xl font-semibold text-ink">{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

function CheckItem({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden="true" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
      )}
      <span className={ok ? 'text-ink' : 'font-medium text-red-700'}>
        {label}
        {detail && <span className="ml-1 text-ink-muted">({detail})</span>}
      </span>
    </li>
  );
}

export function ExamSeatingPage() {
  const { examId = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [options, setOptions] = useState<GenerateOptions>(EMPTY_OPTIONS);
  const [genStart, setGenStart] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<{ message: string; code?: string } | null>(null);
  const [lastResult, setLastResult] = useState<GenerateResponse['result']['run'] | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [regenReason, setRegenReason] = useState('');
  const [regenConfirm, setRegenConfirm] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [unpublishOpen, setUnpublishOpen] = useState(false);
  const [unpublishReason, setUnpublishReason] = useState('');
  const [unpublishError, setUnpublishError] = useState<string | null>(null);

  useEffect(() => {
    if (genStart === null) return;
    const id = window.setInterval(() => setElapsed((Date.now() - genStart) / 1000), 100);
    return () => window.clearInterval(id);
  }, [genStart]);

  const examQuery = useQuery({
    queryKey: ['exam', examId],
    queryFn: () => api.get<{ exam: ExamDetail }>(`/exams/${examId}`),
    enabled: Boolean(examId),
  });
  const previewQuery = useQuery({
    queryKey: ['exam-preview', examId],
    queryFn: () => api.get<PreviewStats>(`/exams/${examId}/seating-preview-stats`),
    enabled: Boolean(examId),
  });
  const seatingQuery = useQuery({
    queryKey: ['seating', examId],
    queryFn: () => api.get<{ run: Run }>(`/seating/exams/${examId}/seating`),
    enabled: Boolean(examId) && Boolean(examQuery.data?.exam) && examQuery.data!.exam.seatingStatus !== 'NOT_GENERATED',
    retry: false,
  });
  const validateQuery = useQuery({
    queryKey: ['seating-validate', examId],
    queryFn: () => api.get<StaleReport>(`/seating/exams/${examId}/seating/validate`),
    enabled: Boolean(examId) && Boolean(seatingQuery.data),
    retry: false,
  });
  const runsQuery = useQuery({
    queryKey: ['seating-runs', examId],
    queryFn: () => api.get<{ runs: RunRow[] }>(`/seating/exams/${examId}/seating/runs`),
    enabled: Boolean(examId),
    retry: false,
  });
  const roomsQuery = useQuery({
    queryKey: ['classrooms-available'],
    queryFn: () => api.get<{ items: ClassroomOption[] }>('/classrooms?status=AVAILABLE&pageSize=100&sort=roomNumber&order=asc'),
  });
  const examListQuery = useQuery({
    queryKey: ['exams-picker'],
    queryFn: () => api.get<{ items: Array<Pick<ExamRow, 'id' | 'subject' | 'paperCode' | 'examDate'>> }>('/exams?pageSize=100&sort=examDate&order=asc'),
  });

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['exam', examId] });
    void queryClient.invalidateQueries({ queryKey: ['exam-preview', examId] });
    void queryClient.invalidateQueries({ queryKey: ['seating', examId] });
    void queryClient.invalidateQueries({ queryKey: ['seating-validate', examId] });
    void queryClient.invalidateQueries({ queryKey: ['seating-runs', examId] });
    void queryClient.invalidateQueries({ queryKey: ['exams'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard-charts'] });
  };

  const generateMutation = useMutation({
    mutationFn: () =>
      api.post<GenerateResponse>(`/seating/exams/${examId}/generate-seating`, {
        mode: options.mode,
        historyDepth: Number(options.historyDepth),
        ...(options.seed.trim() ? { seed: options.seed.trim() } : {}),
        ...(options.roomIds.length > 0 ? { roomIds: options.roomIds } : {}),
      }),
    onSuccess: (data) => {
      setLastResult(data.result.run);
      setFailure(null);
      toast('Seating generated and validated');
      invalidateAll();
    },
    onError: (err) => {
      const details = err instanceof ApiError ? (err.details as { failure?: { code?: string } } | null) : null;
      setFailure({ message: err instanceof ApiError ? err.message : 'Generation failed', code: details?.failure?.code });
      toast(err instanceof ApiError ? err.message : 'Generation failed', 'error');
    },
    onSettled: () => {
      setGenStart(null);
    },
  });

  const publishMutation = useMutation({
    mutationFn: () => api.post<{ published: boolean }>(`/seating/exams/${examId}/publish`),
    onSuccess: () => {
      toast('Seating plan published');
      setPublishOpen(false);
      invalidateAll();
    },
    onError: (err) => {
      toast(err instanceof ApiError ? err.message : 'Publish failed', 'error');
      setPublishOpen(false);
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: () =>
      api.post<GenerateResponse>(`/seating/exams/${examId}/regenerate-seating`, {
        mode: options.mode,
        historyDepth: Number(options.historyDepth),
        ...(options.seed.trim() ? { seed: options.seed.trim() } : {}),
        ...(options.roomIds.length > 0 ? { roomIds: options.roomIds } : {}),
        ...(exam?.seatingStatus === 'PUBLISHED' ? { reason: regenReason.trim(), confirm: true } : {}),
      }),
    onSuccess: (data) => {
      setLastResult(data.result.run);
      setFailure(null);
      setRegenerateOpen(false);
      setRegenReason('');
      setRegenConfirm(false);
      setRegenError(null);
      toast('Seating plan regenerated');
      invalidateAll();
    },
    onError: (err) => {
      setRegenError(err instanceof ApiError ? err.message : 'Regenerate failed');
      if (err instanceof ApiError && err.status !== 409) setRegenerateOpen(false);
    },
  });

  const unpublishMutation = useMutation({
    mutationFn: () => api.post<{ unpublished: boolean }>(`/seating/exams/${examId}/unpublish`, { reason: unpublishReason.trim() }),
    onSuccess: () => {
      toast('Seating plan unpublished');
      setUnpublishOpen(false);
      setUnpublishReason('');
      setUnpublishError(null);
      invalidateAll();
    },
    onError: (err) => {
      setUnpublishError(err instanceof ApiError ? err.message : 'Unpublish failed');
    },
  });

  const exam = examQuery.data?.exam;
  const preview = previewQuery.data;
  const currentRun = seatingQuery.data?.run ?? null;
  const run = lastResult ?? currentRun;
  const report = run?.validationReport ?? null;

  const infeasible = useMemo(
    () => (preview?.conflicts ?? []).filter((c) => INFEASIBLE_CODES.has(c.code)),
    [preview],
  );
  const canGenerate = Boolean(exam) && infeasible.length === 0 && !generateMutation.isPending;
  const hasPlan = Boolean(currentRun) || exam?.seatingStatus !== 'NOT_GENERATED';
  const canPublish = exam?.seatingStatus === 'VALIDATED' && !exam?.isStale && !publishMutation.isPending;
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';

  function startGenerate() {
    if (exam?.seatingStatus === 'PUBLISHED') {
      setRegenReason('');
      setRegenConfirm(false);
      setRegenError(null);
      setRegenerateOpen(true);
      return;
    }
    setFailure(null);
    setLastResult(null);
    setGenStart(Date.now());
    setElapsed(0);
    generateMutation.mutate();
  }

  function submitRegenerate() {
    if (exam?.seatingStatus === 'PUBLISHED') {
      if (regenReason.trim().length < 3) {
        setRegenError('A reason (min 3 characters) is required to regenerate a published plan.');
        return;
      }
      if (!regenConfirm) {
        setRegenError('Confirm that you understand this replaces the published plan.');
        return;
      }
    }
    setRegenError(null);
    regenerateMutation.mutate();
  }

  function submitUnpublish() {
    if (unpublishReason.trim().length < 5) {
      setUnpublishError('A reason (min 5 characters) is required.');
      return;
    }
    setUnpublishError(null);
    unpublishMutation.mutate();
  }

  if (examQuery.isLoading) {
    return (
      <div className="space-y-3">
        <div className="h-6 w-72 animate-pulse rounded bg-surface" />
        <div className="grid gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-surface" />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-lg bg-surface" />
      </div>
    );
  }

  if (examQuery.error || !exam) {
    return (
      <div className="space-y-4">
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {examQuery.error instanceof ApiError ? examQuery.error.message : 'Failed to load exam'}
        </div>
        <Button onClick={() => navigate('/admin/seating')}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to seating plans
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Link to="/admin/seating" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Seating Plans
          </Link>
          <h1 className="text-xl font-semibold text-ink">
            {exam.subject}
            {exam.paperCode && <span className="ml-2 text-sm font-normal text-ink-muted">{exam.paperCode}</span>}
          </h1>
          <p className="text-sm text-ink-muted">
            {exam.examDate} · {exam.startTime} – {exam.endTime}
            {exam.academicYear ? ` · ${exam.academicYear.name}` : ''}
            {exam.semester ? ` · Semester ${exam.semester}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/admin/exams/${examId}/seating/builder`}>
            <Button variant="secondary" size="sm">
              <Wand2 className="h-4 w-4" aria-hidden="true" />
              <span className="ml-1">Allocation builder</span>
            </Button>
          </Link>
          <Select
            aria-label="Switch exam"
            value={examId}
            onChange={(e) => navigate(`/admin/exams/${e.target.value}/seating`)}
            className="w-auto"
          >
            {(examListQuery.data?.items ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.subject} · {x.examDate}
              </option>
            ))}
          </Select>
          <Badge tone={statusTone(exam.status)}>{exam.status}</Badge>
          <Badge tone={seatingStatusTone(exam.seatingStatus)}>{exam.seatingStatus.replace('_', ' ')}</Badge>
          {exam.isStale && <Badge tone="warning">Stale</Badge>}
        </div>
      </div>

      {/* Preview stats */}
      <section aria-label="Feasibility preview" className="rounded-xl border border-line bg-panel p-4">
        <h2 className="text-sm font-semibold text-ink">Feasibility preview</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Eligible students" value={preview?.eligibleCount ?? '—'} hint="Registered and active" />
          <StatTile
            label="Available seats"
            value={preview?.availableSeats ?? '—'}
            hint={preview ? `In ${preview.availableRooms} room(s), after blocks` : undefined}
          />
          <StatTile label="Classrooms required" value={preview?.classroomsRequired ?? '—'} hint="Largest rooms first" />
          <StatTile
            label="Departments"
            value={preview?.departmentsBreakdown.length ?? '—'}
            hint="Represented among eligible"
          />
        </dl>

        {preview && preview.conflicts.length > 0 && (
          <div className="mt-3 space-y-2">
            {preview.conflicts.map((c) => {
              const blocking = INFEASIBLE_CODES.has(c.code);
              return (
                <div
                  key={c.code}
                  role="alert"
                  className={`rounded-md border px-3 py-2 text-sm ${
                    blocking ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900'
                  }`}
                >
                  <span className="mr-2 rounded bg-black/10 px-1.5 py-0.5 font-mono text-xs">{c.code}</span>
                  {c.message}
                  {c.code === 'INSUFFICIENT_SEATS' && typeof c.details?.shortfall === 'number' && (
                    <strong className="ml-1">Additional seats required: {c.details.shortfall}.</strong>
                  )}
                  {c.code === 'NO_AVAILABLE_ROOMS' && (
                    <span className="mt-1 block text-xs">
                      Unblock a classroom or free rooms held by clashing exams, then try again.
                    </span>
                  )}
                  {c.details?.exams && (
                    <ul className="mt-1 ml-5 list-disc space-y-0.5 text-xs opacity-90">
                      {c.details.exams.map((x) => (
                        <li key={x.id}>
                          {x.subject} ({x.examDate} {x.startTime}–{x.endTime})
                          {x.hasSeatingPlan ? ` — plan holds ${x.blockedRooms} room(s)` : ' — no plan yet'}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {preview && preview.departmentsBreakdown.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-ink-muted uppercase">By department</span>
            {preview.departmentsBreakdown.map((d) => (
              <Badge key={d.code} tone="neutral">
                {d.name}: {d.count}
              </Badge>
            ))}
          </div>
        )}
      </section>

      {/* Generation */}
      <section aria-label="Generate seating" className="rounded-xl border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">Generate seating</h2>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => navigate(`/admin/exams/${examId}/seating/visualize`)}
              disabled={!hasPlan}
              title={hasPlan ? 'Open the visual seating layout' : 'Generate a plan first'}
            >
              <Eye className="h-4 w-4" aria-hidden="true" />
              Preview layout
            </Button>
            <Button
              onClick={() => {
                setRegenReason('');
                setRegenConfirm(false);
                setRegenError(null);
                setRegenerateOpen(true);
              }}
              disabled={!hasPlan || regenerateMutation.isPending}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Regenerate
            </Button>
            <Button variant="primary" onClick={() => setPublishOpen(true)} disabled={!canPublish}>
              <Send className="h-4 w-4" aria-hidden="true" />
              Publish
            </Button>
            {isSuperAdmin && (
              <Button
                variant="danger"
                onClick={() => {
                  setUnpublishReason('');
                  setUnpublishError(null);
                  setUnpublishOpen(true);
                }}
                disabled={exam.seatingStatus !== 'PUBLISHED'}
              >
                <Undo2 className="h-4 w-4" aria-hidden="true" />
                Unpublish
              </Button>
            )}
          </div>
        </div>

        <form
          className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            startGenerate();
          }}
        >
          <div className="space-y-3">
            <FormField label="Distribution mode" hint="MIXED spreads departments; BLOCK groups by year/department">
              {(a) => (
                <Select {...a} value={options.mode} onChange={(e) => setOptions((o) => ({ ...o, mode: e.target.value as GenerateOptions['mode'] }))}>
                  <option value="MIXED">MIXED</option>
                  <option value="BLOCK">BLOCK</option>
                </Select>
              )}
            </FormField>
            <FormField label="History depth" hint="Previous papers to avoid repeating seats/rooms (0–5)">
              {(a) => (
                <Input
                  {...a}
                  type="number"
                  min={0}
                  max={5}
                  value={options.historyDepth}
                  onChange={(e) => setOptions((o) => ({ ...o, historyDepth: e.target.value }))}
                />
              )}
            </FormField>
          </div>
          <div className="space-y-3">
            <FormField label="Seed" hint="Optional — same seed reproduces the same plan">
              {(a) => (
                <Input
                  {...a}
                  value={options.seed}
                  placeholder="e.g. 42 or exam-day-A"
                  onChange={(e) => setOptions((o) => ({ ...o, seed: e.target.value }))}
                />
              )}
            </FormField>
            <fieldset className="rounded-md border border-line p-2">
              <legend className="px-1 text-xs font-medium text-ink-muted">Rooms (none selected = all available)</legend>
              <div className="max-h-32 space-y-1 overflow-y-auto pt-1">
                {(roomsQuery.data?.items ?? []).map((r) => (
                  <label key={r.id} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={options.roomIds.includes(r.id)}
                      onChange={(e) =>
                        setOptions((o) => ({
                          ...o,
                          roomIds: e.target.checked
                            ? [...o.roomIds, r.id]
                            : o.roomIds.filter((id) => id !== r.id),
                        }))
                      }
                      className="h-4 w-4 rounded border-line text-brand-600 focus:ring-brand-400"
                    />
                    {r.roomNumber}
                    <span className="text-xs text-ink-muted">
                      {r.building ? `${r.building} · ` : ''}
                      {r.availableSeats} seats
                    </span>
                  </label>
                ))}
                {roomsQuery.isLoading && <p className="text-xs text-ink-muted">Loading rooms…</p>}
              </div>
            </fieldset>
          </div>
          <div className="flex flex-col justify-end gap-2">
            <Button type="submit" variant="primary" disabled={!canGenerate}>
              {generateMutation.isPending ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Generating… {elapsed.toFixed(1)}s
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  {hasPlan ? 'Regenerate plan' : 'Generate seating'}
                </>
              )}
            </Button>
            {exam.seatingStatus === 'PUBLISHED' && (
              <p className="max-w-56 text-xs text-amber-700">
                The plan is published — regenerating requires a reason and replaces it.
              </p>
            )}
          </div>
        </form>

        {infeasible.length > 0 && (
          <p className="mt-3 text-xs font-medium text-red-700">
            Generation is disabled while the preview reports an impossible conflict ({infeasible[0]?.code}).
          </p>
        )}

        {failure && (
          <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 p-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-red-800">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
              Generation failed{failure.code ? ` · ${failure.code}` : ''}
            </p>
            <p className="mt-1 text-sm text-red-700">{failure.message}</p>
          </div>
        )}

        {report && !failure && (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-line bg-canvas p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink">
                  {report.status === 'VALID' ? 'Allocation successful' : 'Allocation invalid'}
                </h3>
                <Badge tone={report.status === 'VALID' ? 'success' : 'danger'}>{report.status}</Badge>
              </div>
              <ul className="mt-3 space-y-1.5">
                <CheckItem
                  ok={report.unassigned === 0}
                  label="All students assigned"
                  detail={`${report.assigned}/${report.students}`}
                />
                <CheckItem
                  ok={report.duplicateSeats.length === 0}
                  label="No duplicate seats"
                  detail={report.duplicateSeats.length ? `${report.duplicateSeats.length} duplicates` : undefined}
                />
                <CheckItem ok={report.duplicateStudents.length === 0} label="No student seated twice" />
                <CheckItem
                  ok={report.capacityViolations.length === 0}
                  label="Capacity constraints satisfied"
                />
                <CheckItem ok={report.unavailableSeatUsed.length === 0} label="Only available seats used" />
                <CheckItem ok={report.ineligibleIncluded.length === 0} label="No ineligible students seated" />
              </ul>
              {report.violations.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-red-700">
                  {report.violations.map((v) => (
                    <li key={v.code}>
                      <span className="font-mono">{v.code}</span>: {v.message}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-ink-muted">
                {report.seatsUsed} seat(s) used · history considered:{' '}
                {report.historyConsidered.enabled ? `depth ${report.historyConsidered.depth}` : 'no'}
              </p>
            </div>

            <div className="rounded-lg border border-line bg-canvas p-4">
              <h3 className="text-sm font-semibold text-ink">Penalty statistics</h3>
              {run?.stats ? (
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-muted">Total penalty</dt>
                    <dd className="font-medium text-ink">
                      {run.totalPenalty ?? '—'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-muted">Iterations</dt>
                    <dd className="font-medium text-ink">{run.stats.iterations}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-muted">Same seat as prev.</dt>
                    <dd className="font-medium text-ink">{run.stats.sameSeatAsPrev}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-muted">Same room as prev.</dt>
                    <dd className="font-medium text-ink">{run.stats.sameRoomAsPrev}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-muted">Same bench as prev.</dt>
                    <dd className="font-medium text-ink">{run.stats.sameBenchNoAsPrev}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-muted">Neighbour repeats</dt>
                    <dd className="font-medium text-ink">{run.stats.sameNeighbourAsPrev}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-muted">Same-dept adjacent</dt>
                    <dd className="font-medium text-ink">{run.stats.sameDeptAdjacent}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-ink-muted">Engine time</dt>
                    <dd className="font-medium text-ink">{run.stats.timeMs} ms</dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-2 text-sm text-ink-muted">No statistics for this run.</p>
              )}
              <p className="mt-3 text-xs text-ink-muted">
                Run {run?.id.slice(0, 8)} · {run?.status} · seed {run?.seed || 'auto'} · generated{' '}
                {run ? new Date(run.generatedAt).toLocaleString() : '—'}
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Validation report + run history */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label="Validation report" className="rounded-xl border border-line bg-panel p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">Validation report</h2>
            {validateQuery.data && (
              <Badge tone={validateQuery.data.status === 'VALID' ? 'success' : 'warning'}>
                {validateQuery.data.status}
              </Badge>
            )}
          </div>
          {!hasPlan && (
            <p className="mt-2 text-sm text-ink-muted">No plan yet — generate seating to validate it.</p>
          )}
          {hasPlan && validateQuery.isLoading && <p className="mt-2 text-sm text-ink-muted">Checking…</p>}
          {hasPlan && validateQuery.error && !(validateQuery.error instanceof ApiError && validateQuery.error.status === 404) && (
            <p className="mt-2 text-sm text-red-700">
              {validateQuery.error instanceof ApiError ? validateQuery.error.message : 'Failed to validate'}
            </p>
          )}
          {validateQuery.data && (
            <div className="mt-3 space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <StatTile label="Eligible now" value={validateQuery.data.eligibleCount} />
                <StatTile label="Seated" value={validateQuery.data.seatedCount} />
              </div>
              <ul className="space-y-1.5">
                <CheckItem
                  ok={validateQuery.data.addedAfterGeneration.length === 0}
                  label="No students added after generation"
                  detail={
                    validateQuery.data.addedAfterGeneration.length
                      ? `${validateQuery.data.addedAfterGeneration.length} added`
                      : undefined
                  }
                />
                <CheckItem
                  ok={validateQuery.data.removedButSeated.length === 0}
                  label="No seated students removed"
                  detail={
                    validateQuery.data.removedButSeated.length
                      ? `${validateQuery.data.removedButSeated.length} affected`
                      : undefined
                  }
                />
                <CheckItem
                  ok={validateQuery.data.disabledRooms.length === 0}
                  label="All used rooms still available"
                  detail={
                    validateQuery.data.disabledRooms.length
                      ? validateQuery.data.disabledRooms.map((r) => r.roomNumber).join(', ')
                      : undefined
                  }
                />
                <CheckItem
                  ok={validateQuery.data.disabledSeats.length === 0}
                  label="All used seats still available"
                  detail={
                    validateQuery.data.disabledSeats.length
                      ? `${validateQuery.data.disabledSeats.length} disabled`
                      : undefined
                  }
                />
              </ul>
              {validateQuery.data.suggestion && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {validateQuery.data.suggestion}
                </p>
              )}
            </div>
          )}
        </section>

        <section aria-label="Run history" className="rounded-xl border border-line bg-panel p-4">
          <h2 className="text-sm font-semibold text-ink">Run history</h2>
          {runsQuery.isLoading && <p className="mt-2 text-sm text-ink-muted">Loading runs…</p>}
          {runsQuery.data && runsQuery.data.runs.length === 0 && (
            <p className="mt-2 text-sm text-ink-muted">No runs yet.</p>
          )}
          {runsQuery.data && runsQuery.data.runs.length > 0 && (
            <>
              <ul className="mt-3 divide-y divide-line">
                {runsQuery.data.runs.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <div className="min-w-0">
                      <span className="font-mono text-xs text-ink-muted">{r.seed}</span>
                      <span className="ml-2 text-xs text-ink-muted">
                        {new Date(r.generatedAt).toLocaleString()} · {r.allocationCount} seated
                        {r.totalPenalty !== null && ` · penalty ${r.totalPenalty}`}
                      </span>
                      {r.failure && (
                        <span className="block text-xs text-red-700">
                          {r.failure.code}: {r.failure.message}
                        </span>
                      )}
                    </div>
                    <Badge tone={RUN_TONES[r.status] ?? 'neutral'}>{r.status}</Badge>
                  </li>
                ))}
              </ul>
              {runsQuery.data.runs.some((r) => r.status === 'PUBLISHED') && (
                <div className="mt-4 flex justify-end">
                  <ExportMenu examId={examId} isPublished />
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* Dialogs */}
      <ConfirmDialog
        open={publishOpen}
        title="Publish seating plan"
        message={`Publish the ${currentRun?.status ?? 'validated'} plan for ${exam.subject}? Students will see their room and bench numbers.`}
        confirmLabel="Publish"
        loading={publishMutation.isPending}
        onConfirm={() => publishMutation.mutate()}
        onCancel={() => setPublishOpen(false)}
      />

      <Modal
        open={regenerateOpen}
        onClose={() => setRegenerateOpen(false)}
        title="Regenerate seating plan"
        footer={
          <>
            <Button onClick={() => setRegenerateOpen(false)} disabled={regenerateMutation.isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submitRegenerate} loading={regenerateMutation.isPending}>
              Regenerate
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => { e.preventDefault(); submitRegenerate(); }} className="space-y-3" noValidate>
          <p className="text-sm text-ink-muted">
            This runs the algorithm again with the current options and replaces the current plan
            {exam.seatingStatus === 'PUBLISHED' ? ' (the published plan will be superseded).' : '.'}
          </p>
          {(exam.seatingStatus === 'PUBLISHED' || regenerateMutation.isError) && (
            <FormField label="Reason" required hint={exam.seatingStatus === 'PUBLISHED' ? 'Min 3 characters — audit logged' : undefined}>
              {(a) => (
                <Textarea {...a} value={regenReason} onChange={(e) => setRegenReason(e.target.value)} placeholder="Why regenerate?" />
              )}
            </FormField>
          )}
          {exam.seatingStatus === 'PUBLISHED' && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={regenConfirm}
                onChange={(e) => setRegenConfirm(e.target.checked)}
                className="h-4 w-4 rounded border-line text-brand-600 focus:ring-brand-400"
              />
              I understand this replaces the published plan.
            </label>
          )}
          {regenError && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {regenError}
            </p>
          )}
        </form>
      </Modal>

      <Modal
        open={unpublishOpen}
        onClose={() => setUnpublishOpen(false)}
        title="Unpublish seating plan"
        footer={
          <>
            <Button onClick={() => setUnpublishOpen(false)} disabled={unpublishMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={submitUnpublish}
              loading={unpublishMutation.isPending}
            >
              Unpublish
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => { e.preventDefault(); submitUnpublish(); }} className="space-y-3" noValidate>
          <p className="text-sm text-ink-muted">
            Students will immediately lose access to their published seat for {exam.subject}.
          </p>
          <FormField label="Reason" required hint="Min 5 characters — audit logged">
            {(a) => (
              <Textarea
                {...a}
                value={unpublishReason}
                onChange={(e) => setUnpublishReason(e.target.value)}
                placeholder="Why unpublish?"
              />
            )}
          </FormField>
          {unpublishError && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {unpublishError}
            </p>
          )}
        </form>
      </Modal>
    </div>
  );
}
