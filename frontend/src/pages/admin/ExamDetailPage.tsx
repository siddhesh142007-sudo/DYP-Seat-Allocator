import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Search, UserPlus } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { statusTone, seatingStatusTone, type BadgeTone } from '../../components/ui/tones';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, SearchInput, type Column, type SortState } from '../../components/ui/DataTable';
import { Select } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/toastContext';
import type { ExamRow } from './ExamsPage';
import type { Department } from './DepartmentsPage';

interface ExamDetail extends ExamRow {
  registrationCounts: Record<string, number>;
  eligibleCount: number;
}

interface RegistrationRow {
  id: string;
  examId: string;
  studentId: string;
  status: 'REGISTERED' | 'ABSENT' | 'WITHHELD' | 'REMOVED';
  registeredAt: string;
  student: {
    id: string;
    rollNumber: string;
    name: string;
    email: string | null;
    division: string | null;
    status: string;
    department: { id: string; name: string; code: string | null } | null;
    academicYear?: { id: string; name: string; code: string | null };
  };
}

interface Conflict {
  code: string;
  message: string;
  details?: {
    exams?: Array<{ id: string; subject: string; examDate: string; startTime: string; endTime: string; hasSeatingPlan: boolean; blockedRooms: number }>;
    eligibleCount?: number;
    availableSeats?: number;
    shortfall?: number;
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

type Tab = 'registrations' | 'eligible';

const REG_STATUS_TONES: Record<RegistrationRow['status'], BadgeTone> = {
  REGISTERED: 'success',
  ABSENT: 'warning',
  WITHHELD: 'warning',
  REMOVED: 'danger',
};

function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-canvas p-4">
      <dt className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold text-ink">{value}</dd>
      {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

export function ExamDetailPage() {
  const { examId = '' } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<Tab>('registrations');
  const [regSearch, setRegSearch] = useState('');
  const [regStatus, setRegStatus] = useState('');
  const [regDept, setRegDept] = useState('');
  const [regPage, setRegPage] = useState(1);
  const [regSort, setRegSort] = useState<SortState>({ key: 'rollNumber', order: 'asc' });
  const [eligSearch, setEligSearch] = useState('');
  const [eligDept, setEligDept] = useState('');
  const [eligPage, setEligPage] = useState(1);
  const [pendingStatus, setPendingStatus] = useState<{ row: RegistrationRow; status: RegistrationRow['status']; label: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [debouncedAddSearch, setDebouncedAddSearch] = useState('');

  const [debouncedRegSearch, setDebouncedRegSearch] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedRegSearch(regSearch.trim()), 300);
    return () => window.clearTimeout(t);
  }, [regSearch]);
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedAddSearch(addSearch.trim()), 300);
    return () => window.clearTimeout(t);
  }, [addSearch]);

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
  const deptsQuery = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get<{ items: Department[] }>('/departments'),
  });

  const regParams = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedRegSearch) p.set('search', debouncedRegSearch);
    if (regStatus) p.set('status', regStatus);
    if (regDept) p.set('departmentId', regDept);
    p.set('page', String(regPage));
    p.set('pageSize', '20');
    p.set('sort', regSort.key);
    p.set('order', regSort.order);
    return p.toString();
  }, [debouncedRegSearch, regStatus, regDept, regPage, regSort]);

  const eligParams = useMemo(() => {
    const p = new URLSearchParams();
    if (eligSearch.trim()) p.set('search', eligSearch.trim());
    if (eligDept) p.set('departmentId', eligDept);
    p.set('page', String(eligPage));
    p.set('pageSize', '20');
    return p.toString();
  }, [eligSearch, eligDept, eligPage]);

  const regQuery = useQuery({
    queryKey: ['exam-registrations', examId, regParams],
    queryFn: () =>
      api.get<{ items: RegistrationRow[]; total: number; page: number; pageSize: number }>(
        `/exams/${examId}/registrations?${regParams}`,
      ),
    enabled: Boolean(examId),
    placeholderData: (prev) => prev,
  });

  const eligQuery = useQuery({
    queryKey: ['exam-eligible', examId, eligParams],
    queryFn: () =>
      api.get<{ items: RegistrationRow[]; total: number; page: number; pageSize: number }>(
        `/exams/${examId}/eligible-students?${eligParams}`,
      ),
    enabled: Boolean(examId) && tab === 'eligible',
    placeholderData: (prev) => prev,
  });

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['exam', examId] });
    void queryClient.invalidateQueries({ queryKey: ['exam-preview', examId] });
    void queryClient.invalidateQueries({ queryKey: ['exam-registrations', examId] });
    void queryClient.invalidateQueries({ queryKey: ['exam-eligible', examId] });
    void queryClient.invalidateQueries({ queryKey: ['exams'] });
  };

  const statusMutation = useMutation({
    mutationFn: ({ row, status }: { row: RegistrationRow; status: RegistrationRow['status'] }) =>
      api.patch<{ examIsStale: boolean }>(`/exams/${examId}/registrations/${row.studentId}`, { status }),
    onSuccess: (_data, vars) => {
      toast(`Marked ${vars.row.student.rollNumber} as ${vars.status.toLowerCase()}`);
      setPendingStatus(null);
      invalidateAll();
    },
    onError: (err) => {
      toast(err instanceof ApiError ? err.message : 'Update failed', 'error');
      setPendingStatus(null);
    },
  });

  const addMutation = useMutation({
    mutationFn: (studentId: string) => api.post(`/exams/${examId}/registrations`, { studentId }),
    onSuccess: () => {
      toast('Student registered for this exam');
      setAddOpen(false);
      setAddSearch('');
      invalidateAll();
    },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Add failed', 'error'),
  });

  const addResultsQuery = useQuery({
    queryKey: ['students-search', examId, debouncedAddSearch],
    queryFn: () =>
      api.get<{ items: Array<{ id: string; rollNumber: string; name: string; division: string | null; department: { name: string } | null }> }>(
        `/students?search=${encodeURIComponent(debouncedAddSearch)}&academicYearId=${examQuery.data?.exam.academicYearId ?? ''}&status=ACTIVE&pageSize=10`,
      ),
    enabled: addOpen && debouncedAddSearch.length >= 1 && Boolean(examQuery.data?.exam.academicYearId),
  });

  const exam = examQuery.data?.exam;
  const preview = previewQuery.data;
  const totalRegistrations = exam
    ? Object.values(exam.registrationCounts).reduce((sum, n) => sum + n, 0)
    : 0;

  function askStatus(row: RegistrationRow, status: RegistrationRow['status'], label: string) {
    if (status === 'REGISTERED') {
      statusMutation.mutate({ row, status });
    } else {
      setPendingStatus({ row, status, label });
    }
  }

  const regColumns: Column<RegistrationRow>[] = [
    { key: 'rollNumber', header: 'Roll No.', sortable: true, render: (r) => <span className="font-medium">{r.student.rollNumber}</span> },
    { key: 'name', header: 'Name', sortable: true },
    { key: 'department', header: 'Department', render: (r) => r.student.department?.name ?? '—' },
    { key: 'division', header: 'Div', render: (r) => r.student.division ?? '—' },
    { key: 'status', header: 'Status', sortable: true, render: (r) => <Badge tone={REG_STATUS_TONES[r.status]}>{r.status}</Badge> },
    { key: 'registeredAt', header: 'Registered', sortable: true, render: (r) => new Date(r.registeredAt).toLocaleDateString() },
  ];

  const regActions = (r: RegistrationRow) => (
    <div className="flex flex-wrap justify-end gap-1">
      {r.status !== 'REGISTERED' && (
        <Button size="sm" variant="ghost" aria-label={`Re-add ${r.student.rollNumber}`} onClick={() => askStatus(r, 'REGISTERED', 'Re-add')}>
          Re-add
        </Button>
      )}
      {r.status === 'REGISTERED' && (
        <>
          <Button size="sm" variant="ghost" aria-label={`Mark ${r.student.rollNumber} absent`} onClick={() => askStatus(r, 'ABSENT', 'Absent')}>
            Absent
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Withhold ${r.student.rollNumber}`} onClick={() => askStatus(r, 'WITHHELD', 'Withhold')}>
            Withhold
          </Button>
          <Button size="sm" variant="ghost" aria-label={`Remove ${r.student.rollNumber}`} onClick={() => askStatus(r, 'REMOVED', 'Remove')}>
            <span className="text-red-500">Remove</span>
          </Button>
        </>
      )}
    </div>
  );

  const eligColumns: Column<RegistrationRow>[] = [
    { key: 'rollNumber', header: 'Roll No.', render: (r) => <span className="font-medium">{r.student.rollNumber}</span> },
    { key: 'name', header: 'Name' },
    { key: 'department', header: 'Department', render: (r) => r.student.department?.name ?? '—' },
    { key: 'division', header: 'Div', render: (r) => r.student.division ?? '—' },
  ];

  if (examQuery.isLoading) {
    return (
      <div className="space-y-3">
        <div className="h-6 w-64 animate-pulse rounded bg-surface" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-surface" />
          ))}
        </div>
      </div>
    );
  }

  if (examQuery.error || !exam) {
    return (
      <div className="space-y-4">
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {examQuery.error instanceof ApiError ? examQuery.error.message : 'Failed to load exam'}
        </div>
        <Button onClick={() => navigate('/admin/exams')}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to exams
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Link to="/admin/exams" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Exams
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
        <div className="flex flex-wrap gap-2">
          <Badge tone={statusTone(exam.status)}>{exam.status}</Badge>
          <Badge tone={seatingStatusTone(exam.seatingStatus)}>{exam.seatingStatus.replace('_', ' ')}</Badge>
          {exam.isStale && <Badge tone="warning">Plan stale</Badge>}
        </div>
      </div>

      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Eligible students" value={preview?.eligibleCount ?? exam.eligibleCount} hint="Registered and active" />
        <StatCard
          label="Available seats"
          value={preview?.availableSeats ?? '—'}
          hint={preview ? `In ${preview.availableRooms} room(s), after blocked rooms` : undefined}
        />
        <StatCard
          label="Rooms required"
          value={preview?.classroomsRequired ?? '—'}
          hint="Minimum, largest rooms first"
        />
        <StatCard label="Registrations" value={totalRegistrations} hint={`${exam.registrationCounts.REGISTERED ?? 0} active`} />
      </dl>

      {preview && preview.conflicts.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">Detected conflicts</h2>
          <ul className="mt-2 space-y-1.5">
            {preview.conflicts.map((c) => (
              <li key={c.code} className="text-sm text-amber-900">
                <span className="mr-2 rounded bg-amber-200/70 px-1.5 py-0.5 font-mono text-xs">{c.code}</span>
                {c.message}
                {c.details?.exams && (
                  <ul className="mt-1 ml-5 list-disc space-y-0.5 text-amber-800">
                    {c.details.exams.map((x) => (
                      <li key={x.id}>
                        {x.subject} ({x.examDate} {x.startTime}–{x.endTime})
                        {x.hasSeatingPlan ? ` — plan holds ${x.blockedRooms} room(s)` : ' — no plan yet'}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview && preview.departmentsBreakdown.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink-muted uppercase">By department</span>
          {preview.departmentsBreakdown.map((d) => (
            <Badge key={d.code} tone="neutral">
              {d.name}: {d.count}
            </Badge>
          ))}
        </div>
      )}

      <div className="border-b border-line">
        <nav className="-mb-px flex gap-6" aria-label="Exam detail sections">
          {(['registrations', 'eligible'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`border-b-2 pb-2 text-sm font-medium transition-colors ${
                tab === t ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {t === 'registrations' ? 'Registrations' : 'Eligible students'}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'registrations' ? (
        <DataTable
          columns={regColumns}
          rows={regQuery.data?.items ?? []}
          keyFn={(r) => r.id}
          loading={regQuery.isLoading}
          error={
            regQuery.error
              ? regQuery.error instanceof ApiError
                ? regQuery.error.message
                : 'Failed to load'
              : null
          }
          onRetry={() => void regQuery.refetch()}
          emptyTitle="No registrations found"
          emptyDescription="Adjust the filters, or add a student."
          sort={regSort}
          onSortChange={(s) => {
            setRegSort(s);
            setRegPage(1);
          }}
          pagination={{
            page: regQuery.data?.page ?? regPage,
            pageSize: regQuery.data?.pageSize ?? 20,
            total: regQuery.data?.total ?? 0,
          }}
          onPageChange={setRegPage}
          toolbar={
            <>
              <SearchInput value={regSearch} onChange={setRegSearch} label="Search registrations" placeholder="Name or roll…" />
              <Select
                aria-label="Filter by registration status"
                value={regStatus}
                onChange={(e) => {
                  setRegStatus(e.target.value);
                  setRegPage(1);
                }}
                className="w-auto"
              >
                <option value="">All statuses</option>
                <option value="REGISTERED">Registered</option>
                <option value="ABSENT">Absent</option>
                <option value="WITHHELD">Withheld</option>
                <option value="REMOVED">Removed</option>
              </Select>
              <Select
                aria-label="Filter by department"
                value={regDept}
                onChange={(e) => {
                  setRegDept(e.target.value);
                  setRegPage(1);
                }}
                className="w-auto"
              >
                <option value="">All departments</option>
                {(deptsQuery.data?.items ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
              <Button variant="primary" onClick={() => setAddOpen(true)}>
                <UserPlus className="h-4 w-4" aria-hidden="true" />
                Add student
              </Button>
            </>
          }
          rowActions={regActions}
        />
      ) : (
        <DataTable
          columns={eligColumns}
          rows={eligQuery.data?.items ?? []}
          keyFn={(r) => r.studentId}
          loading={eligQuery.isLoading}
          error={
            eligQuery.error
              ? eligQuery.error instanceof ApiError
                ? eligQuery.error.message
                : 'Failed to load'
              : null
          }
          onRetry={() => void eligQuery.refetch()}
          emptyTitle="No eligible students"
          emptyDescription="Registered, active students of this exam's academic year appear here."
          pagination={{
            page: eligQuery.data?.page ?? eligPage,
            pageSize: eligQuery.data?.pageSize ?? 20,
            total: eligQuery.data?.total ?? 0,
          }}
          onPageChange={setEligPage}
          toolbar={
            <>
              <SearchInput value={eligSearch} onChange={setEligSearch} label="Search eligible students" placeholder="Name or roll…" />
              <Select
                aria-label="Filter eligible by department"
                value={eligDept}
                onChange={(e) => {
                  setEligDept(e.target.value);
                  setEligPage(1);
                }}
                className="w-auto"
              >
                <option value="">All departments</option>
                {(deptsQuery.data?.items ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </>
          }
        />
      )}

      <ConfirmDialog
        open={pendingStatus !== null}
        title={pendingStatus ? `${pendingStatus.label} student` : ''}
        message={
          pendingStatus
            ? `${pendingStatus.label} ${pendingStatus.row.student.rollNumber} (${pendingStatus.row.student.name})? ${
                statusMutation.isPending ? '' : 'This updates the eligible count and flags any existing plan as stale.'
              }`
            : ''
        }
        confirmLabel={pendingStatus?.label ?? 'Confirm'}
        danger={pendingStatus?.status === 'REMOVED'}
        loading={statusMutation.isPending}
        onConfirm={() => pendingStatus && statusMutation.mutate({ row: pendingStatus.row, status: pendingStatus.status })}
        onCancel={() => setPendingStatus(null)}
      />

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add student to exam"
        footer={<Button onClick={() => setAddOpen(false)}>Close</Button>}
      >
        <div className="space-y-3">
          <label className="relative block">
            <span className="sr-only">Search students</span>
            <Search className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-ink-muted" aria-hidden="true" />
            <input
              value={addSearch}
              onChange={(e) => setAddSearch(e.target.value)}
              placeholder="Search by name or roll number…"
              className="w-full rounded-md border border-line bg-canvas py-2 pr-3 pl-8 text-sm text-ink focus:border-brand-500 focus:ring-2 focus:ring-brand-400 focus:outline-none"
            />
          </label>
          {addSearch.trim().length === 0 && (
            <p className="text-sm text-ink-muted">Type at least one character to search active students of this year.</p>
          )}
          {addResultsQuery.isLoading && <p className="text-sm text-ink-muted">Searching…</p>}
          {addResultsQuery.data && addResultsQuery.data.items.length === 0 && (
            <p className="text-sm text-ink-muted">No matching active students in this academic year.</p>
          )}
          <ul className="divide-y divide-line">
            {(addResultsQuery.data?.items ?? []).map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <p className="text-sm font-medium text-ink">{s.name}</p>
                  <p className="text-xs text-ink-muted">
                    {s.rollNumber}
                    {s.department ? ` · ${s.department.name}` : ''}
                    {s.division ? ` · Div ${s.division}` : ''}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={addMutation.isPending}
                  onClick={() => addMutation.mutate(s.id)}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    </div>
  );
}
