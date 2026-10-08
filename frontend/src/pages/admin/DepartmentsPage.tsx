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

export interface Department {
  id: string;
  name: string;
  code: string;
  status: 'ACTIVE' | 'INACTIVE';
  _count?: { students: number };
}

interface DeptForm {
  name: string;
  code: string;
  status: 'ACTIVE' | 'INACTIVE';
}

const EMPTY_FORM: DeptForm = { name: '', code: '', status: 'ACTIVE' };

export function DepartmentsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = user?.role === 'SUPER_ADMIN' || user?.role === 'EXAM_ADMIN';

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);
  const [form, setForm] = useState<DeptForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Department | null>(null);

  const query = useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get<{ items: Department[] }>('/departments'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['departments'] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = { name: form.name.trim(), code: form.code.trim(), status: form.status };
      if (editing) return api.put(`/departments/${editing.id}`, payload);
      return api.post('/departments', payload);
    },
    onSuccess: () => {
      toast(editing ? 'Department updated' : 'Department created');
      setModalOpen(false);
      setEditing(null);
      void invalidate();
      // Student filters also show department lists.
      void queryClient.invalidateQueries({ queryKey: ['academic-years'] });
    },
    onError: (err) => setFormError(err instanceof ApiError ? err.message : 'Save failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/departments/${id}`),
    onSuccess: () => {
      toast('Department deleted');
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

  function openEdit(dept: Department) {
    setEditing(dept);
    setForm({ name: dept.name, code: dept.code, status: dept.status });
    setFormError(null);
    setModalOpen(true);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.code.trim()) {
      setFormError('Name and code are required');
      return;
    }
    saveMutation.mutate();
  }

  const columns: Column<Department>[] = [
    { key: 'name', header: 'Name', render: (d) => <span className="font-medium">{d.name}</span> },
    { key: 'code', header: 'Code' },
    { key: 'students', header: 'Students', render: (d) => d._count?.students ?? 0 },
    { key: 'status', header: 'Status', render: (d) => <Badge tone={statusTone(d.status)}>{d.status}</Badge> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Departments</h1>
          <p className="text-sm text-ink-muted">Departments students belong to; seats are balanced across them.</p>
        </div>
        {canEdit && (
          <Button variant="primary" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New department
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={query.data?.items ?? []}
        keyFn={(d) => d.id}
        loading={query.isLoading}
        error={query.error ? (query.error instanceof ApiError ? query.error.message : 'Failed to load') : null}
        onRetry={() => void query.refetch()}
        emptyTitle="No departments yet"
        emptyDescription="Create the first department before importing students."
        rowActions={
          canEdit
            ? (d) => (
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" aria-label={`Edit ${d.name}`} onClick={() => openEdit(d)}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Delete ${d.name}`} onClick={() => setDeleting(d)}>
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
        title={editing ? 'Edit department' : 'New department'}
        footer={
          <>
            <Button onClick={() => setModalOpen(false)} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onSubmit} loading={saveMutation.isPending}>
              {editing ? 'Save changes' : 'Create department'}
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
                placeholder="e.g. Computer Engineering"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            )}
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Code" required hint="Unique, e.g. COMP">
              {(a) => (
                <Input
                  {...a}
                  value={form.code}
                  placeholder="e.g. COMP"
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Status">
              {(a) => (
                <Select
                  {...a}
                  value={form.status}
                  onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as DeptForm['status'] }))}
                >
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                </Select>
              )}
            </FormField>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete department"
        message={
          deleting
            ? `Delete "${deleting.name}"? Departments referenced by students cannot be deleted — deactivate instead.`
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
