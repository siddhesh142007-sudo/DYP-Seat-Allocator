import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Armchair, FileSpreadsheet, Pencil, Plus, Trash2 } from 'lucide-react';
import { ClassroomImportModal } from '../../components/ClassroomImportModal';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../features/auth/AuthContext';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { statusTone } from '../../components/ui/tones';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, SearchInput, type Column } from '../../components/ui/DataTable';
import { FormField, Input, Select, Textarea } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/toastContext';

interface ClassroomRow {
  id: string;
  roomNumber: string;
  building: string | null;
  floor: string | null;
  status: 'AVAILABLE' | 'UNAVAILABLE';
  capacity: number;
  notes: string | null;
  totalSeats: number;
  availableSeats: number;
}

interface Seat {
  id: string;
  benchNumber: number;
  status: 'AVAILABLE' | 'DISABLED';
  rowNo: number | null;
  colNo: number | null;
}

interface ClassroomDetail extends ClassroomRow {
  seats: Seat[];
}

interface ClassroomForm {
  roomNumber: string;
  building: string;
  floor: string;
  notes: string;
  status: 'AVAILABLE' | 'UNAVAILABLE';
}

const EMPTY_FORM: ClassroomForm = { roomNumber: '', building: '', floor: '', notes: '', status: 'AVAILABLE' };

export function ClassroomsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = user?.role === 'SUPER_ADMIN' || user?.role === 'EXAM_ADMIN';

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ClassroomRow | null>(null);
  const [form, setForm] = useState<ClassroomForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ClassroomRow | null>(null);
  const [suggestUnavailable, setSuggestUnavailable] = useState<ClassroomRow | null>(null);
  const [seatsFor, setSeatsFor] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // Room awaiting delete; kept outside `deleting` so the 409 handler can offer
  // "mark unavailable" for the same room.
  const [pendingDeleteRoom, setPendingDeleteRoom] = useState<ClassroomRow | null>(null);

  const params = new URLSearchParams();
  if (search.trim()) params.set('search', search.trim());
  if (statusFilter) params.set('status', statusFilter);
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  const queryKey = ['classrooms', params.toString()];

  const listQuery = useQuery({
    queryKey,
    queryFn: () => api.get<{ items: ClassroomRow[]; total: number; page: number; pageSize: number }>(`/classrooms?${params}`),
    placeholderData: (prev) => prev,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['classrooms'] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        roomNumber: form.roomNumber.trim(),
        building: form.building.trim() || null,
        floor: form.floor.trim() || null,
        notes: form.notes.trim() || null,
        status: form.status,
      };
      if (editing) return api.put(`/classrooms/${editing.id}`, payload);
      return api.post('/classrooms', payload);
    },
    onSuccess: () => {
      toast(editing ? 'Classroom updated' : 'Classroom created');
      setModalOpen(false);
      setEditing(null);
      void invalidate();
    },
    onError: (err) => setFormError(err instanceof ApiError ? err.message : 'Save failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/classrooms/${id}`),
    onSuccess: () => {
      toast('Classroom deleted');
      setDeleting(null);
      void invalidate();
    },
    onError: (err) => {
      setDeleting(null);
      if (err instanceof ApiError && err.status === 409) {
        // Room has seating history — offer the backend's suggested alternative.
        toast(err.message, 'error');
        setSuggestUnavailable(pendingDeleteRoom);
      } else {
        toast(err instanceof ApiError ? err.message : 'Delete failed', 'error');
      }
    },
  });

  const markUnavailableMutation = useMutation({
    mutationFn: (room: ClassroomRow) => api.put(`/classrooms/${room.id}`, { status: 'UNAVAILABLE' }),
    onSuccess: () => {
      toast('Classroom marked unavailable');
      setSuggestUnavailable(null);
      void invalidate();
    },
    onError: (err) => {
      toast(err instanceof ApiError ? err.message : 'Update failed', 'error');
      setSuggestUnavailable(null);
    },
  });

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(room: ClassroomRow) {
    setEditing(room);
    setForm({
      roomNumber: room.roomNumber,
      building: room.building ?? '',
      floor: room.floor ?? '',
      notes: room.notes ?? '',
      status: room.status,
    });
    setFormError(null);
    setModalOpen(true);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form.roomNumber.trim()) {
      setFormError('Room number is required');
      return;
    }
    saveMutation.mutate();
  }

  const columns: Column<ClassroomRow>[] = [
    { key: 'roomNumber', header: 'Room', render: (c) => <span className="font-medium">{c.roomNumber}</span> },
    { key: 'building', header: 'Building', render: (c) => c.building ?? '—' },
    { key: 'floor', header: 'Floor', render: (c) => c.floor ?? '—' },
    { key: 'capacity', header: 'Capacity', render: (c) => `${c.capacity} seats` },
    {
      key: 'available',
      header: 'Available',
      render: (c) => (
        <span className="text-ink-muted">
          {c.availableSeats}/{c.totalSeats}
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (c) => <Badge tone={statusTone(c.status)}>{c.status}</Badge> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Classrooms</h1>
          <p className="text-sm text-ink-muted">Rooms, benches and their exam-ready capacity.</p>
        </div>
        {canEdit && (
          <Button variant="primary" onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New room
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={listQuery.data?.items ?? []}
        keyFn={(c) => c.id}
        loading={listQuery.isLoading}
        error={listQuery.error ? (listQuery.error instanceof ApiError ? listQuery.error.message : 'Failed to load') : null}
        onRetry={() => void listQuery.refetch()}
        emptyTitle="No classrooms yet"
        emptyDescription="Create a room, then generate its benches."
        toolbar={
          <>
            <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} label="Search rooms" placeholder="Room or building…" />
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
              <option value="AVAILABLE">Available</option>
              <option value="UNAVAILABLE">Unavailable</option>
            </Select>
            {canEdit && (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
                  <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
                  <span className="ml-1 hidden sm:inline">Import CSV</span>
                </Button>
                <Button size="sm" variant="primary" onClick={openCreate}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span className="ml-1 hidden sm:inline">New room</span>
                </Button>
              </div>
            )}
          </>
        }
        pagination={{
          page: listQuery.data?.page ?? page,
          pageSize: listQuery.data?.pageSize ?? pageSize,
          total: listQuery.data?.total ?? 0,
        }}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
        rowActions={
          canEdit
            ? (c) => (
                <div className="flex justify-end gap-1">
                  <Button size="sm" variant="ghost" aria-label={`Manage benches of ${c.roomNumber}`} onClick={() => setSeatsFor(c.id)}>
                    <Armchair className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Edit ${c.roomNumber}`} onClick={() => openEdit(c)}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete ${c.roomNumber}`}
                    onClick={() => {
                      setPendingDeleteRoom(c);
                      setDeleting(c);
                    }}
                  >
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
        title={editing ? `Edit ${editing.roomNumber}` : 'New classroom'}
        footer={
          <>
            <Button onClick={() => setModalOpen(false)} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onSubmit} loading={saveMutation.isPending}>
              {editing ? 'Save changes' : 'Create room'}
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
          <div className="grid grid-cols-3 gap-4">
            <FormField label="Room number" required className="col-span-1">
              {(a) => (
                <Input
                  {...a}
                  value={form.roomNumber}
                  onChange={(e) => setForm((f) => ({ ...f, roomNumber: e.target.value }))}
                />
              )}
            </FormField>
            <FormField label="Building">
              {(a) => (
                <Input value={form.building} {...a} onChange={(e) => setForm((f) => ({ ...f, building: e.target.value }))} />
              )}
            </FormField>
            <FormField label="Floor">
              {(a) => <Input value={form.floor} {...a} onChange={(e) => setForm((f) => ({ ...f, floor: e.target.value }))} />}
            </FormField>
          </div>
          <FormField label="Notes">
            {(a) => (
              <Textarea value={form.notes} {...a} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            )}
          </FormField>
          <FormField label="Status">
            {(a) => (
              <Select
                {...a}
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as ClassroomForm['status'] }))}
              >
                <option value="AVAILABLE">Available</option>
                <option value="UNAVAILABLE">Unavailable</option>
              </Select>
            )}
          </FormField>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete classroom"
        message={
          deleting
            ? `Delete ${deleting.roomNumber}? Rooms with seating history cannot be deleted — they must be marked unavailable instead.`
            : ''
        }
        confirmLabel="Delete"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        onCancel={() => setDeleting(null)}
      />

      <ConfirmDialog
        open={suggestUnavailable !== null}
        title="Room has seating history"
        message={`This room cannot be deleted. Mark ${suggestUnavailable?.roomNumber ?? 'it'} unavailable instead? It stays for historical seating plans but new runs will skip it.`}
        confirmLabel="Mark unavailable"
        loading={markUnavailableMutation.isPending}
        onConfirm={() => suggestUnavailable && markUnavailableMutation.mutate(suggestUnavailable)}
        onCancel={() => setSuggestUnavailable(null)}
      />

      {seatsFor && <SeatsModal classroomId={seatsFor} onClose={() => setSeatsFor(null)} canEdit={canEdit} />}
      <ClassroomImportModal open={importOpen} onClose={() => setImportOpen(false)} onImported={invalidate} />
    </div>
  );
}

function SeatsModal({ classroomId, onClose, canEdit }: { classroomId: string; onClose: () => void; canEdit: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [genCount, setGenCount] = useState('20');
  const [genRows, setGenRows] = useState('');
  const [genCols, setGenCols] = useState('');
  const [clearConfirm, setClearConfirm] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['classroom', classroomId],
    queryFn: () => api.get<{ classroom: ClassroomDetail }>(`/classrooms/${classroomId}`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['classroom', classroomId] });
    void queryClient.invalidateQueries({ queryKey: ['classrooms'] });
  };

  const generateMutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = { count: Number(genCount) };
      if (genRows && genCols) {
        payload.rows = Number(genRows);
        payload.cols = Number(genCols);
      }
      return api.post(`/classrooms/${classroomId}/generate-seats`, payload);
    },
    onSuccess: () => {
      toast('Benches generated');
      setGenError(null);
      invalidate();
    },
    onError: (err) => setGenError(err instanceof ApiError ? err.message : 'Generate failed'),
  });

  const clearMutation = useMutation({
    mutationFn: () => api.delete(`/classrooms/${classroomId}/seats`),
    onSuccess: () => {
      toast('Benches cleared');
      setClearConfirm(false);
      invalidate();
    },
    onError: (err) => {
      toast(err instanceof ApiError ? err.message : 'Clear failed', 'error');
      setClearConfirm(false);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ seatId, next }: { seatId: string; next: 'AVAILABLE' | 'DISABLED' }) =>
      api.patch(`/classrooms/${classroomId}/seats/${seatId}`, { status: next }),
    onSuccess: () => invalidate(),
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Update failed', 'error'),
  });

  const classroom = detailQuery.data?.classroom;
  const hasSeats = (classroom?.seats.length ?? 0) > 0;

  function onGenerate(e: FormEvent) {
    e.preventDefault();
    if (!genCount || Number(genCount) < 1) {
      setGenError('Enter a bench count');
      return;
    }
    generateMutation.mutate();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Benches — ${classroom?.roomNumber ?? '…'}`}
      description={
        classroom
          ? `Capacity ${classroom.capacity} · ${classroom.availableSeats} of ${classroom.totalSeats} benches available`
          : 'Loading…'
      }
      size="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {detailQuery.isLoading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />
          ))}
        </div>
      )}

      {detailQuery.error && (
        <p className="text-sm text-red-600" role="alert">
          {detailQuery.error instanceof ApiError ? detailQuery.error.message : 'Failed to load room'}
        </p>
      )}

      {classroom && (
        <div className="space-y-5">
          {!hasSeats ? (
            canEdit && (
              <form onSubmit={onGenerate} className="space-y-3 rounded-lg border border-line bg-surface p-4">
                <h3 className="text-sm font-semibold text-ink">Generate benches</h3>
                {genError && (
                  <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {genError}
                  </div>
                )}
                <div className="grid grid-cols-3 gap-3">
                  <FormField label="Benches" required>
                    {(a) => (
                      <Input {...a} type="number" min={1} max={500} value={genCount} onChange={(e) => setGenCount(e.target.value)} />
                    )}
                  </FormField>
                  <FormField label="Rows" hint="Optional layout">
                    {(a) => <Input {...a} type="number" min={1} value={genRows} onChange={(e) => setGenRows(e.target.value)} />}
                  </FormField>
                  <FormField label="Columns">
                    {(a) => <Input {...a} type="number" min={1} value={genCols} onChange={(e) => setGenCols(e.target.value)} />}
                  </FormField>
                </div>
                <Button type="submit" variant="primary" loading={generateMutation.isPending}>
                  Generate benches
                </Button>
              </form>
            )
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-ink">
                  {classroom.seats.length} benches — click to toggle availability
                </h3>
                {canEdit && (
                  <Button size="sm" variant="danger" onClick={() => setClearConfirm(true)}>
                    Clear all benches
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {classroom.seats.map((seat) => (
                  <button
                    key={seat.id}
                    type="button"
                    disabled={!canEdit || toggleMutation.isPending}
                    aria-label={`Bench ${seat.benchNumber}, ${seat.status.toLowerCase()}${seat.rowNo ? `, row ${seat.rowNo}` : ''}`}
                    aria-pressed={seat.status === 'AVAILABLE'}
                    onClick={() =>
                      toggleMutation.mutate({
                        seatId: seat.id,
                        next: seat.status === 'AVAILABLE' ? 'DISABLED' : 'AVAILABLE',
                      })
                    }
                    className={
                      'flex h-14 w-14 flex-col items-center justify-center rounded-lg border text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none ' +
                      (seat.status === 'AVAILABLE'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                        : 'border-line bg-slate-100 text-slate-400 hover:bg-slate-200')
                    }
                  >
                    <span>{seat.benchNumber}</span>
                    <span className="text-[10px] font-normal">
                      {seat.rowNo ? `r${seat.rowNo}c${seat.colNo}` : seat.status === 'AVAILABLE' ? 'on' : 'off'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <ConfirmDialog
            open={clearConfirm}
            title="Clear all benches"
            message={`Remove every bench from ${classroom.roomNumber}? Rooms with seating history cannot be cleared.`}
            confirmLabel="Clear benches"
            danger
            loading={clearMutation.isPending}
            onConfirm={() => clearMutation.mutate()}
            onCancel={() => setClearConfirm(false)}
          />
        </div>
      )}
    </Modal>
  );
}
