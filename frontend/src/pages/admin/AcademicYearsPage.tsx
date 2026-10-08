import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../features/auth/AuthContext';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { statusTone } from '../../components/ui/tones';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { FormField, Input, Select } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/toastContext';

export interface AcademicYear {
  id: string;
  name: string;
  code: string | null;
  orderIndex: number;
  status: 'ACTIVE' | 'INACTIVE';
  _count?: { students: number; exams: number };
}

interface YearForm {
  name: string;
  code: string;
  orderIndex: string;
  status: 'ACTIVE' | 'INACTIVE';
}

const EMPTY_FORM: YearForm = { name: '', code: '', orderIndex: '0', status: 'ACTIVE' };

export function AcademicYearsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = user?.role === 'SUPER_ADMIN' || user?.role === 'EXAM_ADMIN';

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AcademicYear | null>(null);
  const [form, setForm] = useState<YearForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AcademicYear | null>(null);

  const query = useQuery({
    queryKey: ['academic-years'],
    queryFn: () => api.get<{ items: AcademicYear[] }>('/academic-years'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['academic-years'] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        code: form.code.trim() || undefined,
        orderIndex: Number(form.orderIndex) || 0,
        status: form.status,
      };
      if (editing) return api.put(`/academic-years/${editing.id}`, payload);
      return api.post('/academic-years', payload);
    },
    onSuccess: () => {
      toast(editing ? 'Academic year updated' : 'Academic year created');
      setModalOpen(false);
      setEditing(null);
      void invalidate();
    },
    onError: (err) => setFormError(err instanceof ApiError ? err.message : 'Save failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/academic-years/${id}`),
    onSuccess: () => {
      toast('Academic year deleted');
      setDeleting(null);
      void invalidate();
    },
    onError: (err) => {
      toast(err instanceof ApiError ? err.message : 'Delete failed', 'error');
      setDeleting(null);
    },
  });

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(year: AcademicYear) {
    setEditing(year);
    setForm({
      name: year.name,
      code: year.code ?? '',
      orderIndex: String(year.orderIndex),
      status: year.status,
    });
    setFormError(null);
    setModalOpen(true);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setFormError('Name is required');
      return;
    }
    saveMutation.mutate();
  }

  const columns: Column<AcademicYear>[] = [
    { key: 'name', header: 'Name', render: (y) => <span className="font-medium">{y.name}</span> },
    { key: 'code', header: 'Code', render: (y) => y.code ?? '—' },
    { key: 'orderIndex', header: 'Order' },
    {
      key: 'status',
      header: 'Status',
      render: (y) => <Badge tone={statusTone(y.status)}>{y.status}</Badge>,
    },
    {
      key: 'usage',
      header: 'Usage',
      render: (y) => (
        <span className="text-ink-muted">
          {y._count?.students ?? 0} students · {y._count?.exams ?? 0} exams
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Academic Years</h1>
          <p className="text-sm text-ink-muted">Years used to group students, exams and seating history.</p>
        </div>
        {canEdit && (
          <Button variant="primary" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New year
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={query.data?.items ?? []}
        keyFn={(y) => y.id}
        loading={query.isLoading}
        error={query.error ? (query.error instanceof ApiError ? query.error.message : 'Failed to load') : null}
        onRetry={() => void query.refetch()}
        emptyTitle="No academic years yet"
        emptyDescription="Create the first academic year to start adding students."
        rowActions={
          canEdit
            ? (y) => (
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" aria-label={`Edit ${y.name}`} onClick={() => openEdit(y)}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Delete ${y.name}`} onClick={() => setDeleting(y)}>
                    <Trash2 className="h-4 w-4 text-red-500" aria-hidden="true" />
                  </Button>
                </div>
              )
            : undefined
        }
      />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Edit academic year' : 'New academic year'}
        footer={
          <>
            <Button onClick={() => setModalOpen(false)} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onSubmit} loading={saveMutation.isPending}>
              {editing ? 'Save changes' : 'Create year'}
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
          <FormField label="Name" required>
            {(a) => (
              <Input
                {...a}
                value={form.name}
                placeholder="e.g. 2026-27"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            )}
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Code" hint="Optional short code">
              {(a) => (
                <Input
                  {...a}
                  value={form.code}
                  placeholder="e.g. AY2627"
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Order">
              {(a) => (
                <Input
                  {...a}
                  type="number"
                  min={0}
                  value={form.orderIndex}
                  onChange={(e) => setForm((f) => ({ ...f, orderIndex: e.target.value }))}
                />
              )}
            </FormField>
          </div>
          <FormField label="Status">
            {(a) => (
              <Select
                {...a}
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as YearForm['status'] }))}
              >
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </Select>
            )}
          </FormField>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete academic year"
        message={
          deleting
            ? `Delete "${deleting.name}"? Years referenced by students or exams cannot be deleted — deactivate instead.`
            : ''
        }
        confirmLabel="Delete"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
