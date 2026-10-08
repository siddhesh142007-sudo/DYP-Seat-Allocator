import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Plus, RefreshCw, Trash2, Wand2 } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { FormField, Input, Select } from '../../components/ui/FormField';
import { useToast } from '../../components/ui/toastContext';

interface Cohort {
  yearCode: 'FE' | 'SE' | 'TE' | 'BE';
  branchCode: string;
  division: string;
  count: number;
  minSerial: number | null;
  maxSerial: number | null;
}

interface ClassroomOption {
  id: string;
  roomNumber: string;
  building: string | null;
  floor: string | null;
  availableSeats: number;
}

interface Intent {
  id: string;
  classroomId: string;
  roomNumber: string | null;
  floor: string | null;
  yearCode: string;
  branchCode: string;
  division: string;
  fromSerial: number;
  toSerial: number;
  rowCount: number | null;
  colCount: number | null;
  seatOffset: number;
  strictRollOrder: boolean;
  studentCount: number;
  availableBenches: number;
}

interface BlockForm {
  cohortKey: string;
  classroomId: string;
  fromSerial: string;
  toSerial: string;
  rowCount: string;
  colCount: string;
  strictRollOrder: boolean;
}

const EMPTY_FORM: BlockForm = {
  cohortKey: '',
  classroomId: '',
  fromSerial: '',
  toSerial: '',
  rowCount: '',
  colCount: '',
  strictRollOrder: false,
};

/** Extracts the structured reason the API attached to a rejection. */
function reasonOf(err: unknown): string {
  if (err instanceof ApiError) {
    const details = err.details as { code?: string } | null;
    if (details?.code) return `${err.message} (${details.code})`;
    return err.message;
  }
  return 'Request failed';
}

export function AllocationBuilderPage() {
  const { examId = '' } = useParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<BlockForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Intent | null>(null);

  const examQuery = useQuery({
    queryKey: ['exam', examId],
    queryFn: () => api.get<{ exam: { id: string; subject: string; paperCode: string | null; examDate: string } }>(
      `/exams/${examId}`,
    ),
    enabled: Boolean(examId),
  });

  const cohortsQuery = useQuery({
    queryKey: ['dypit-cohorts'],
    queryFn: () => api.get<{ cohorts: Cohort[] }>('/dypit/cohorts'),
  });

  const roomsQuery = useQuery({
    queryKey: ['classrooms-available'],
    queryFn: () =>
      api.get<{ items: ClassroomOption[] }>('/classrooms?status=AVAILABLE&pageSize=100&sort=roomNumber&order=asc'),
  });

  const intentsQuery = useQuery({
    queryKey: ['dypit-intents', examId],
    queryFn: () => api.get<{ intents: Intent[] }>(`/dypit/exams/${examId}/intents`),
    enabled: Boolean(examId),
  });

  const explainQuery = useQuery({
    queryKey: ['dypit-intents', examId, 'explain'],
    queryFn: () => api.get<{ totalStudents: number }>(`/dypit/exams/${examId}/intents/explain`),
    enabled: Boolean(examId) && (intentsQuery.data?.intents.length ?? 0) > 0,
    retry: false,
  });

  const selectedCohort = useMemo(
    () => cohortsQuery.data?.cohorts.find((c) => cohortKey(c) === form.cohortKey),
    [cohortsQuery.data, form.cohortKey],
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['dypit-intents', examId] });
    void queryClient.invalidateQueries({ queryKey: ['dypit-cohorts'] });
  };

  const createMutation = useMutation({
    mutationFn: () => {
      const cohort = cohortKeyOf(selectedCohort);
      if (!cohort) throw new Error('Select a cohort first');
      const hasGrid = form.rowCount !== '' && form.colCount !== '';
      return api.post<{ intent: Intent }>(`/dypit/exams/${examId}/intents`, {
        classroomId: form.classroomId,
        yearCode: cohort.yearCode,
        branchCode: cohort.branchCode,
        division: cohort.division,
        fromSerial: Number(form.fromSerial),
        toSerial: Number(form.toSerial),
        ...(hasGrid ? { rowCount: Number(form.rowCount), colCount: Number(form.colCount) } : {}),
        strictRollOrder: form.strictRollOrder,
      });
    },
    onSuccess: (data) => {
      toast(`Added ${data.intent.studentCount} students to room ${data.intent.roomNumber}`);
      setForm(EMPTY_FORM);
      setFormError(null);
      invalidate();
    },
    onError: (err) => setFormError(reasonOf(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (intentId: string) => api.delete(`/dypit/exams/${examId}/intents/${intentId}`),
    onSuccess: () => {
      toast('Block removed');
      setDeleting(null);
      invalidate();
    },
    onError: (err) => {
      setDeleting(null);
      toast(reasonOf(err), 'error');
    },
  });

  const generateMutation = useMutation({
    mutationFn: () =>
      api.post<{ result: { runId: string; totalSeated: number; totalPenalty: number } }>(
        `/dypit/exams/${examId}/generate-from-intents`,
        { replace: true },
      ),
    onSuccess: (data) => {
      toast(`Generated: ${data.result.totalSeated} students seated`);
      invalidate();
    },
    onError: (err) => toast(reasonOf(err), 'error'),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!form.cohortKey) {
      setFormError('Choose the year, branch and division');
      return;
    }
    if (!form.classroomId) {
      setFormError('Choose the classroom for this range');
      return;
    }
    const from = Number(form.fromSerial);
    const to = Number(form.toSerial);
    if (!Number.isInteger(from) || from < 1) {
      setFormError('From serial must be a whole number starting at 1');
      return;
    }
    if (!Number.isInteger(to) || to < from) {
      setFormError('To serial must be a whole number at or after the from serial');
      return;
    }
    if ((form.rowCount === '') !== (form.colCount === '')) {
      setFormError('Give both rows and columns, or neither');
      return;
    }
    createMutation.mutate();
  }

  const intents = intentsQuery.data?.intents ?? [];
  const totalPlanned = intents.reduce((sum, i) => sum + i.studentCount, 0);
  const exam = examQuery.data?.exam;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <Link
          to={`/admin/exams/${examId}/seating`}
          className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Seating generation
        </Link>
        <h1 className="text-xl font-semibold text-ink">Allocation builder</h1>
        <p className="text-sm text-ink-muted">
          {exam
            ? `${exam.subject}${exam.paperCode ? ` (${exam.paperCode})` : ''} — map roll-number ranges to classrooms.`
            : 'Map roll-number ranges to classrooms.'}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Blocks planned" value={intents.length} />
        <Stat label="Students planned" value={totalPlanned} />
        <Stat
          label="Rooms used"
          value={new Set(intents.map((i) => i.classroomId)).size}
        />
      </div>

      {/* Add block */}
      <section aria-label="Add allocation block" className="rounded-xl border border-line bg-panel p-4">
        <h2 className="text-sm font-semibold text-ink">Add a range to a room</h2>
        <form onSubmit={onSubmit} className="mt-3 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <FormField label="Year / branch / division" required>
              {(a) => (
                <Select
                  {...a}
                  value={form.cohortKey}
                  onChange={(e) => {
                    const key = e.target.value;
                    setForm((f) => ({ ...f, cohortKey: key, fromSerial: '', toSerial: '' }));
                    setFormError(null);
                  }}
                >
                  <option value="">Select…</option>
                  {(cohortsQuery.data?.cohorts ?? []).map((c) => (
                    <option key={cohortKey(c)} value={cohortKey(c)}>
                      {c.yearCode} · {c.branchCode} · {c.division} ({c.count})
                    </option>
                  ))}
                </Select>
              )}
            </FormField>

            <FormField label="Classroom" required>
              {(a) => (
                <Select
                  {...a}
                  value={form.classroomId}
                  onChange={(e) => setForm((f) => ({ ...f, classroomId: e.target.value }))}
                >
                  <option value="">Select…</option>
                  {(roomsQuery.data?.items ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.roomNumber}
                      {r.floor ? ` · Floor ${r.floor}` : ''} ({r.availableSeats} free)
                    </option>
                  ))}
                </Select>
              )}
            </FormField>

            <FormField
              label="From serial"
              required
              hint={
                selectedCohort
                  ? `Rolls run ${selectedCohort.minSerial ?? 1}–${selectedCohort.maxSerial ?? '?'}`
                  : 'e.g. 01'
              }
            >
              {(a) => (
                <Input
                  {...a}
                  type="number"
                  min={1}
                  value={form.fromSerial}
                  onChange={(e) => setForm((f) => ({ ...f, fromSerial: e.target.value }))}
                  placeholder="01"
                />
              )}
            </FormField>

            <FormField label="To serial" required hint="e.g. 45">
              {(a) => (
                <Input
                  {...a}
                  type="number"
                  min={1}
                  value={form.toSerial}
                  onChange={(e) => setForm((f) => ({ ...f, toSerial: e.target.value }))}
                  placeholder="45"
                />
              )}
            </FormField>

            <FormField label="Rows (optional)">
              {(a) => (
                <Input
                  {...a}
                  type="number"
                  min={1}
                  value={form.rowCount}
                  onChange={(e) => setForm((f) => ({ ...f, rowCount: e.target.value }))}
                  placeholder="5"
                />
              )}
            </FormField>

            <FormField label="Columns (optional)">
              {(a) => (
                <Input
                  {...a}
                  type="number"
                  min={1}
                  value={form.colCount}
                  onChange={(e) => setForm((f) => ({ ...f, colCount: e.target.value }))}
                  placeholder="9"
                />
              )}
            </FormField>
          </div>

          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={form.strictRollOrder}
              onChange={(e) => setForm((f) => ({ ...f, strictRollOrder: e.target.checked }))}
            />
            Seat in strict roll order (no shuffle) for easy invigilation
          </label>

          {formError && (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {formError}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={createMutation.isPending}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span className="ml-1">Add block</span>
            </Button>
            <Button onClick={() => void generateMutation.mutateAsync()} loading={generateMutation.isPending} disabled={intents.length === 0}>
              <Wand2 className="h-4 w-4" aria-hidden="true" />
              <span className="ml-1">Generate plan</span>
            </Button>
            <Button onClick={() => void intentsQuery.refetch()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              <span className="ml-1">Refresh</span>
            </Button>
          </div>
        </form>
      </section>

      {/* Planned blocks */}
      <section aria-label="Planned blocks" className="rounded-xl border border-line bg-panel p-4">
        <h2 className="text-sm font-semibold text-ink">Planned blocks</h2>
        {intentsQuery.isLoading && <p className="mt-2 text-sm text-ink-muted">Loading…</p>}
        {intentsQuery.error && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {reasonOf(intentsQuery.error)}
          </p>
        )}
        {!intentsQuery.isLoading && intents.length === 0 && (
          <p className="mt-2 text-sm text-ink-muted">
            No blocks yet. Add one above, then generate.
          </p>
        )}
        {intents.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full divide-y divide-line text-sm">
              <thead className="bg-surface text-left text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-2 py-2">Range</th>
                  <th className="px-2 py-2">Room</th>
                  <th className="px-2 py-2">Students</th>
                  <th className="px-2 py-2">Layout</th>
                  <th className="px-2 py-2">Order</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {intents.map((i) => (
                  <tr key={i.id}>
                    <td className="px-2 py-2 font-mono text-xs text-ink">{rangeLabel(i)}</td>
                    <td className="px-2 py-2">
                      {i.roomNumber}
                      {i.floor ? <span className="text-ink-muted"> · F{i.floor}</span> : null}
                    </td>
                    <td className="px-2 py-2">{i.studentCount}</td>
                    <td className="px-2 py-2">
                      {i.rowCount && i.colCount ? `${i.rowCount}×${i.colCount}` : 'by roll'}
                    </td>
                    <td className="px-2 py-2">
                      <Badge tone={i.strictRollOrder ? 'brand' : 'neutral'}>
                        {i.strictRollOrder ? 'Roll order' : 'Shuffled'}
                      </Badge>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove block for room ${i.roomNumber}`}
                        onClick={() => setDeleting(i)}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" aria-hidden="true" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Generate result */}
      {generateMutation.data && (
        <section
          aria-label="Generation result"
          className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-900"
        >
          <p className="font-medium">
            Plan generated: {generateMutation.data.result.totalSeated} students seated, penalty{' '}
            {generateMutation.data.result.totalPenalty}.
          </p>
          <p className="mt-1">
            <Link to={`/admin/exams/${examId}/seating`} className="underline">
              Review, validate and publish
            </Link>
          </p>
        </section>
      )}

      {generateMutation.error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <AlertTriangle className="mr-1 inline h-4 w-4" aria-hidden="true" />
          {reasonOf(generateMutation.error)}
        </p>
      )}

      {explainQuery.data && intents.length > 0 && (
        <p className="text-xs text-ink-muted">
          Plan preview: {explainQuery.data.totalStudents} students across {intents.length} block(s). Nothing is
          reserved until you generate.
        </p>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Remove this block"
        message={
          deleting
            ? `Remove ${deleting.yearCode}-${deleting.branchCode}-${deleting.division} serial ${deleting.fromSerial}-${deleting.toSerial} from the plan?`
            : ''
        }
        confirmLabel="Remove block"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line bg-canvas p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold text-ink">{value}</dd>
    </div>
  );
}

/** "SE-AIDS-C_01 → SE-AIDS-C_20", as one string so it renders as one node. */
function rangeLabel(i: Intent): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const prefix = `${i.yearCode}-${i.branchCode}-${i.division}`;
  return `${prefix}_${pad(i.fromSerial)} → ${prefix}_${pad(i.toSerial)}`;
}

function cohortKey(c: Cohort): string {
  return `${c.yearCode}|${c.branchCode}|${c.division}`;
}

function cohortKeyOf(c: Cohort | undefined): Cohort | undefined {
  return c;
}