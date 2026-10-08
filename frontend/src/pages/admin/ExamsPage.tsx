import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Pencil, Plus } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../features/auth/AuthContext';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { statusTone, seatingStatusTone } from '../../components/ui/tones';
import { DataTable, SearchInput, type Column, type SortState } from '../../components/ui/DataTable';
import { FormField, Input, Select } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/toastContext';
import type { AcademicYear } from './AcademicYearsPage';

export interface ExamRow {
  id: string;
  subject: string;
  paperCode: string | null;
  examDate: string;
  startTime: string;
  endTime: string;
  semester: number | null;
  status: 'PLANNED' | 'COMPLETED' | 'CANCELLED';
  seatingStatus: 'NOT_GENERATED' | 'DRAFT' | 'VALIDATED' | 'PUBLISHED';
  isStale: boolean;
  academicYearId: string;
  academicYear?: { id: string; name: string; code: string | null };
  registrationCount?: number;
}

interface ExamForm {
  subject: string;
  paperCode: string;
  examDate: string;
  startTime: string;
  endTime: string;
  semester: string;
  academicYearId: string;
  status: 'PLANNED' | 'COMPLETED' | 'CANCELLED';
  autoRegister: boolean;
}

const EMPTY_FORM: ExamForm = {
  subject: '',
  paperCode: '',
  examDate: '',
  startTime: '09:00',
  endTime: '12:00',
  semester: '',
  academicYearId: '',
  status: 'PLANNED',
  autoRegister: true,
};

export function ExamsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = user?.role === 'SUPER_ADMIN' || user?.role === 'EXAM_ADMIN';

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sort, setSort] = useState<SortState>({ key: 'examDate', order: 'asc' });

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ExamRow | null>(null);
  const [form, setForm] = useState<ExamForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedSearch) p.set('search', debouncedSearch);
    if (statusFilter) p.set('status', statusFilter);
    if (yearFilter) p.set('academicYearId', yearFilter);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    p.set('sort', sort.key);
    p.set('order', sort.order);
    return p.toString();
  }, [debouncedSearch, statusFilter, yearFilter, page, pageSize, sort]);

  const examsQuery = useQuery({
    queryKey: ['exams', params],
    queryFn: () => api.get<{ items: ExamRow[]; total: number; page: number; pageSize: number }>(`/exams?${params}`),
    placeholderData: (prev) => prev,
  });

  const yearsQuery = useQuery({
    queryKey: ['academic-years'],
    queryFn: () => api.get<{ items: AcademicYear[] }>('/academic-years'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['exams'] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        subject: form.subject.trim(),
        paperCode: form.paperCode.trim() || null,
        examDate: form.examDate,
        startTime: form.startTime,
        endTime: form.endTime,
        semester: form.semester ? Number(form.semester) : null,
        academicYearId: form.academicYearId,
        status: form.status,
        ...(!editing ? { autoRegister: form.autoRegister } : {}),
      };
      if (editing) return api.put<{ exam: ExamRow }>(`/exams/${editing.id}`, payload);
      return api.post<{ exam: ExamRow }>('/exams', payload);
    },
    onSuccess: (data) => {
      toast(editing ? 'Exam updated' : 'Exam created');
      setModalOpen(false);
      setEditing(null);
      void invalidate();
      if (!editing && data?.exam) navigate(`/admin/exams/${data.exam.id}`);
    },
    onError: (err) => setFormError(err instanceof ApiError ? err.message : 'Save failed'),
  });

  function openCreate() {
    setEditing(null);
    const years = yearsQuery.data?.items.filter((y) => y.status === 'ACTIVE') ?? [];
    const today = new Date().toISOString().slice(0, 10);
    setForm({ ...EMPTY_FORM, examDate: today, academicYearId: years[0]?.id ?? '' });
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(exam: ExamRow) {
    setEditing(exam);
    setForm({
      subject: exam.subject,
      paperCode: exam.paperCode ?? '',
      examDate: exam.examDate,
      startTime: exam.startTime,
      endTime: exam.endTime,
      semester: exam.semester ? String(exam.semester) : '',
      academicYearId: exam.academicYearId,
      status: exam.status,
      autoRegister: false,
    });
    setFormError(null);
    setModalOpen(true);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const errs: string[] = [];
    if (!form.subject.trim()) errs.push('Subject is required');
    if (!form.examDate) errs.push('Date is required');
    if (!form.startTime || !form.endTime) errs.push('Start and end times are required');
    else if (form.endTime <= form.startTime) errs.push('End time must be after start time');
    if (!form.academicYearId) errs.push('Select an academic year');
    if (form.semester && (Number.isNaN(Number(form.semester)) || Number(form.semester) < 1)) {
      errs.push('Semester must be a positive number');
    }
    if (errs.length > 0) {
      setFormError(errs.join(' · '));
      return;
    }
    setFormError(null);
    saveMutation.mutate();
  }

  const columns: Column<ExamRow>[] = [
    {
      key: 'subject',
      header: 'Subject',
      sortable: true,
      render: (x) => (
        <div>
          <span className="font-medium">{x.subject}</span>
          {x.paperCode && <span className="ml-2 text-xs text-ink-muted">{x.paperCode}</span>}
        </div>
      ),
    },
    { key: 'examDate', header: 'Date', sortable: true },
    { key: 'time', header: 'Time', render: (x) => `${x.startTime} – ${x.endTime}` },
    { key: 'academicYear', header: 'Year', render: (x) => x.academicYear?.name ?? '—' },
    { key: 'status', header: 'Status', sortable: true, render: (x) => <Badge tone={statusTone(x.status)}>{x.status}</Badge> },
    {
      key: 'seating',
      header: 'Seating',
      render: (x) => (
        <span className="inline-flex gap-1">
          <Badge tone={seatingStatusTone(x.seatingStatus)}>{x.seatingStatus.replace('_', ' ')}</Badge>
          {x.isStale && <Badge tone="warning">Stale</Badge>}
        </span>
      ),
    },
    { key: 'registrations', header: 'Registered', render: (x) => x.registrationCount ?? '—' },
  ];

  const toolbar = (
    <>
      <SearchInput value={search} onChange={setSearch} label="Search exams" placeholder="Subject or paper code…" />
      <Select
        aria-label="Filter by status"
        value={statusFilter}
        onChange={(e) => {
          setStatusFilter(e.target.value);
          setPage(1);
        }}
        className="w-auto"
      >
        <option value="">All statuses</option>
        <option value="PLANNED">Planned</option>
        <option value="COMPLETED">Completed</option>
        <option value="CANCELLED">Cancelled</option>
      </Select>
      <Select
        aria-label="Filter by academic year"
        value={yearFilter}
        onChange={(e) => {
          setYearFilter(e.target.value);
          setPage(1);
        }}
        className="w-auto"
      >
        <option value="">All years</option>
        {(yearsQuery.data?.items ?? []).map((y) => (
          <option key={y.id} value={y.id}>
            {y.name}
          </option>
        ))}
      </Select>
      {canEdit && (
        <Button variant="primary" onClick={openCreate}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          New exam
        </Button>
      )}
    </>
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">Exams</h1>
        <p className="text-sm text-ink-muted">Schedule exams, manage registrations and preview seating feasibility.</p>
      </div>

      <DataTable
        columns={columns}
        rows={examsQuery.data?.items ?? []}
        keyFn={(x) => x.id}
        loading={examsQuery.isLoading}
        error={
          examsQuery.error
            ? examsQuery.error instanceof ApiError
              ? examsQuery.error.message
              : 'Failed to load'
            : null
        }
        onRetry={() => void examsQuery.refetch()}
        emptyTitle="No exams found"
        emptyDescription="Adjust the filters, or create a new exam."
        toolbar={toolbar}
        sort={sort}
        onSortChange={(s) => {
          setSort(s);
          setPage(1);
        }}
        pagination={{
          page: examsQuery.data?.page ?? page,
          pageSize: examsQuery.data?.pageSize ?? pageSize,
          total: examsQuery.data?.total ?? 0,
        }}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
        rowActions={
          canEdit
            ? (x) => (
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" aria-label={`Open ${x.subject}`} onClick={() => navigate(`/admin/exams/${x.id}`)}>
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Edit ${x.subject}`} onClick={() => openEdit(x)}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              )
            : undefined
        }
      />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Edit ${editing.subject}` : 'New exam'}
        footer={
          <>
            <Button onClick={() => setModalOpen(false)} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onSubmit} loading={saveMutation.isPending}>
              {editing ? 'Save changes' : 'Create exam'}
            </Button>
          </>
        }
      >
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {formError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {formError}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Subject" required>
              {(a) => (
                <Input
                  {...a}
                  value={form.subject}
                  onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Paper code">
              {(a) => (
                <Input
                  {...a}
                  value={form.paperCode}
                  placeholder="e.g. CS-201"
                  onChange={(e) => setForm((f) => ({ ...f, paperCode: e.target.value }))}
                />
              )}
            </FormField>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <FormField label="Date" required>
              {(a) => (
                <Input
                  {...a}
                  type="date"
                  value={form.examDate}
                  onChange={(e) => setForm((f) => ({ ...f, examDate: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Start time" required>
              {(a) => (
                <Input
                  {...a}
                  type="time"
                  value={form.startTime}
                  onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="End time" required>
              {(a) => (
                <Input
                  {...a}
                  type="time"
                  value={form.endTime}
                  onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
                />
              )}
            </FormField>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <FormField label="Academic year" required>
              {(a) => (
                <Select
                  {...a}
                  value={form.academicYearId}
                  onChange={(e) => setForm((f) => ({ ...f, academicYearId: e.target.value }))}
                >
                  <option value="" disabled>
                    Select…
                  </option>
                  {(yearsQuery.data?.items ?? []).map((y) => (
                    <option key={y.id} value={y.id}>
                      {y.name}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Semester" hint="Optional">
              {(a) => (
                <Input
                  {...a}
                  type="number"
                  min={1}
                  max={16}
                  value={form.semester}
                  onChange={(e) => setForm((f) => ({ ...f, semester: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Status">
              {(a) => (
                <Select
                  {...a}
                  value={form.status}
                  onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as ExamForm['status'] }))}
                >
                  <option value="PLANNED">Planned</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="CANCELLED">Cancelled</option>
                </Select>
              )}
            </FormField>
          </div>
          {!editing && (
            <div className="space-y-1.5">
              <span className="block text-sm font-medium text-ink">Registrations</span>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={form.autoRegister}
                  onChange={(e) => setForm((f) => ({ ...f, autoRegister: e.target.checked }))}
                  className="h-4 w-4 rounded border-line text-brand-600 focus:ring-brand-400"
                />
                Auto-register all active students of the selected year
              </label>
            </div>
          )}
        </form>
      </Modal>
    </div>
  );
}
