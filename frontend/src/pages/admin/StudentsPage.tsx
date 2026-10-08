import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Pencil, Plus, UserX } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../features/auth/AuthContext';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { statusTone } from '../../components/ui/tones';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, SearchInput, type Column, type SortState } from '../../components/ui/DataTable';
import { FormField, Input, Select } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/toastContext';
import type { AcademicYear } from './AcademicYearsPage';
import type { Department } from './DepartmentsPage';
import { StudentImportModal } from './StudentImportModal';

interface StudentRow {
  id: string;
  rollNumber: string;
  name: string;
  email: string | null;
  division: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  academicYearId: string;
  departmentId: string;
  academicYear: { id: string; name: string; code: string | null };
  department: { id: string; name: string; code: string | null };
  user: { id: string; role: string; status: string } | null;
}

interface StudentForm {
  rollNumber: string;
  name: string;
  email: string;
  division: string;
  status: 'ACTIVE' | 'INACTIVE';
  academicYearId: string;
  departmentId: string;
  createLogin: boolean;
  password: string;
}

const EMPTY_FORM: StudentForm = {
  rollNumber: '',
  name: '',
  email: '',
  division: '',
  status: 'ACTIVE',
  academicYearId: '',
  departmentId: '',
  createLogin: false,
  password: '',
};

export function StudentsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = user?.role === 'SUPER_ADMIN' || user?.role === 'EXAM_ADMIN';

  const [search, setSearch] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [divisionFilter, setDivisionFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sort, setSort] = useState<SortState>({ key: 'createdAt', order: 'desc' });

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<StudentRow | null>(null);
  const [form, setForm] = useState<StudentForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState<StudentRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // Debounce the search box so we do not query per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedSearch) p.set('search', debouncedSearch);
    if (yearFilter) p.set('academicYearId', yearFilter);
    if (deptFilter) p.set('departmentId', deptFilter);
    if (divisionFilter) p.set('division', divisionFilter.trim());
    if (statusFilter) p.set('status', statusFilter);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    p.set('sort', sort.key);
    p.set('order', sort.order);
    return p.toString();
  }, [debouncedSearch, yearFilter, deptFilter, divisionFilter, statusFilter, page, pageSize, sort]);

  const studentsQuery = useQuery({
    queryKey: ['students', params],
    queryFn: () =>
      api.get<{ items: StudentRow[]; total: number; page: number; pageSize: number }>(`/students?${params}`),
    placeholderData: (prev) => prev,
  });

  const yearsQuery = useQuery({
    queryKey: ['academic-years'],
    queryFn: () => api.get<{ items: AcademicYear[] }>('/academic-years'),
  });
  const deptsQuery = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get<{ items: Department[] }>('/departments'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['students'] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        rollNumber: form.rollNumber.trim(),
        name: form.name.trim(),
        email: form.email.trim() || null,
        division: form.division.trim() || null,
        status: form.status,
        academicYearId: form.academicYearId,
        departmentId: form.departmentId,
        ...(!editing && form.createLogin
          ? { createLogin: true, password: form.password || undefined }
          : {}),
      };
      if (editing) return api.put(`/students/${editing.id}`, payload);
      return api.post('/students', payload);
    },
    onSuccess: () => {
      toast(editing ? 'Student updated' : 'Student created');
      setModalOpen(false);
      setEditing(null);
      void invalidate();
      void queryClient.invalidateQueries({ queryKey: ['departments'] });
      void queryClient.invalidateQueries({ queryKey: ['academic-years'] });
    },
    onError: (err) => setFormError(err instanceof ApiError ? err.message : 'Save failed'),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/students/${id}`),
    onSuccess: () => {
      toast('Student deactivated');
      setDeactivating(null);
      void invalidate();
    },
    onError: (err) => {
      toast(err instanceof ApiError ? err.message : 'Deactivate failed', 'error');
      setDeactivating(null);
    },
  });

  function openCreate() {
    setEditing(null);
    const years = yearsQuery.data?.items.filter((y) => y.status === 'ACTIVE') ?? [];
    const depts = deptsQuery.data?.items.filter((d) => d.status === 'ACTIVE') ?? [];
    setForm({
      ...EMPTY_FORM,
      academicYearId: years[0]?.id ?? '',
      departmentId: depts[0]?.id ?? '',
    });
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(student: StudentRow) {
    setEditing(student);
    setForm({
      rollNumber: student.rollNumber,
      name: student.name,
      email: student.email ?? '',
      division: student.division ?? '',
      status: student.status,
      academicYearId: student.academicYearId,
      departmentId: student.departmentId,
      createLogin: false,
      password: '',
    });
    setFormError(null);
    setModalOpen(true);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const errs: string[] = [];
    if (!form.rollNumber.trim()) errs.push('Roll number is required');
    if (!form.name.trim()) errs.push('Name is required');
    if (!form.academicYearId) errs.push('Select an academic year');
    if (!form.departmentId) errs.push('Select a department');
    if (!editing && form.createLogin && form.password && form.password.length < 8) {
      errs.push('Password must be at least 8 characters');
    }
    if (errs.length > 0) {
      setFormError(errs.join(' · '));
      return;
    }
    setFormError(null);
    saveMutation.mutate();
  }

  const columns: Column<StudentRow>[] = [
    { key: 'rollNumber', header: 'Roll No.', sortable: true, render: (s) => <span className="font-medium">{s.rollNumber}</span> },
    { key: 'name', header: 'Name', sortable: true },
    { key: 'academicYear', header: 'Year', render: (s) => s.academicYear.name },
    { key: 'department', header: 'Department', render: (s) => s.department.name },
    { key: 'division', header: 'Div', render: (s) => s.division ?? '—' },
    { key: 'status', header: 'Status', render: (s) => <Badge tone={statusTone(s.status)}>{s.status}</Badge> },
    {
      key: 'login',
      header: 'Login',
      render: (s) =>
        s.user ? <Badge tone={s.user.status === 'ACTIVE' ? 'brand' : 'neutral'}>Yes</Badge> : <span className="text-ink-muted">No</span>,
    },
  ];

  const toolbar = (
    <>
      <SearchInput value={search} onChange={setSearch} label="Search students" placeholder="Name, roll or email…" />
      <Select aria-label="Filter by academic year" value={yearFilter} onChange={(e) => { setYearFilter(e.target.value); setPage(1); }} className="w-auto">
        <option value="">All years</option>
        {(yearsQuery.data?.items ?? []).map((y) => (
          <option key={y.id} value={y.id}>
            {y.name}
          </option>
        ))}
      </Select>
      <Select aria-label="Filter by department" value={deptFilter} onChange={(e) => { setDeptFilter(e.target.value); setPage(1); }} className="w-auto">
        <option value="">All departments</option>
        {(deptsQuery.data?.items ?? []).map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </Select>
      <Input
        aria-label="Filter by division"
        value={divisionFilter}
        placeholder="Division"
        className="w-28"
        onChange={(e) => { setDivisionFilter(e.target.value); setPage(1); }}
      />
      <Select aria-label="Filter by status" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="w-auto">
        <option value="">All statuses</option>
        <option value="ACTIVE">Active</option>
        <option value="INACTIVE">Inactive</option>
      </Select>
      {canEdit && (
        <>
          <Button variant="primary" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New student
          </Button>
          <Button onClick={() => setImportOpen(true)}>
            <FileUp className="h-4 w-4" aria-hidden="true" />
            Import
          </Button>
        </>
      )}
    </>
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-ink">Students</h1>
        <p className="text-sm text-ink-muted">Roster with division, department and login management.</p>
      </div>

      <DataTable
        columns={columns}
        rows={studentsQuery.data?.items ?? []}
        keyFn={(s) => s.id}
        loading={studentsQuery.isLoading}
        error={studentsQuery.error ? (studentsQuery.error instanceof ApiError ? studentsQuery.error.message : 'Failed to load') : null}
        onRetry={() => void studentsQuery.refetch()}
        emptyTitle="No students found"
        emptyDescription="Adjust the filters, or create/import students."
        toolbar={toolbar}
        sort={sort}
        onSortChange={(s) => {
          setSort(s);
          setPage(1);
        }}
        pagination={{
          page: studentsQuery.data?.page ?? page,
          pageSize: studentsQuery.data?.pageSize ?? pageSize,
          total: studentsQuery.data?.total ?? 0,
        }}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
        rowActions={
          canEdit
            ? (s) => (
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" aria-label={`Edit ${s.name}`} onClick={() => openEdit(s)}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Deactivate ${s.name}`}
                    disabled={s.status === 'INACTIVE'}
                    onClick={() => setDeactivating(s)}
                  >
                    <UserX className="h-4 w-4 text-red-500" aria-hidden="true" />
                  </Button>
                </div>
              )
            : undefined
        }
      />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Edit ${editing.rollNumber}` : 'New student'}
        footer={
          <>
            <Button onClick={() => setModalOpen(false)} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onSubmit} loading={saveMutation.isPending}>
              {editing ? 'Save changes' : 'Create student'}
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
            <FormField label="Roll number" required>
              {(a) => (
                <Input
                  {...a}
                  value={form.rollNumber}
                  disabled={Boolean(editing)}
                  onChange={(e) => setForm((f) => ({ ...f, rollNumber: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Name" required>
              {(a) => (
                <Input value={form.name} {...a} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              )}
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Email">
              {(a) => (
                <Input
                  {...a}
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Division">
              {(a) => (
                <Input
                  {...a}
                  value={form.division}
                  placeholder="e.g. A"
                  onChange={(e) => setForm((f) => ({ ...f, division: e.target.value }))}
                />
              )}
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-4">
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
            <FormField label="Department" required>
              {(a) => (
                <Select
                  {...a}
                  value={form.departmentId}
                  onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value }))}
                >
                  <option value="" disabled>
                    Select…
                  </option>
                  {(deptsQuery.data?.items ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Status">
              {(a) => (
                <Select
                  {...a}
                  value={form.status}
                  onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as StudentForm['status'] }))}
                >
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                </Select>
              )}
            </FormField>
            {!editing && (
              <div className="space-y-1.5">
                <span className="block text-sm font-medium text-ink">Login account</span>
                <label className="flex h-10 cursor-pointer items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={form.createLogin}
                    onChange={(e) => setForm((f) => ({ ...f, createLogin: e.target.checked }))}
                    className="h-4 w-4 rounded border-line text-brand-600 focus:ring-brand-400"
                  />
                  Create portal login
                </label>
              </div>
            )}
          </div>
          {!editing && form.createLogin && (
            <FormField
              label="Initial password"
              hint="Optional — defaults to Welcome@<ROLL>. The student must change it at first login."
            >
              {(a) => (
                <Input
                  {...a}
                  type="text"
                  value={form.password}
                  autoComplete="new-password"
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                />
              )}
            </FormField>
          )}
        </form>
      </Modal>

      <ConfirmDialog
        open={deactivating !== null}
        title="Deactivate student"
        message={
          deactivating
            ? `Deactivate ${deactivating.rollNumber} (${deactivating.name})? Their portal login is disabled too. Seating history is kept.`
            : ''
        }
        confirmLabel="Deactivate"
        danger
        loading={deactivateMutation.isPending}
        onConfirm={() => deactivating && deactivateMutation.mutate(deactivating.id)}
        onCancel={() => setDeactivating(null)}
      />

      <StudentImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void invalidate()}
      />
    </div>
  );
}
