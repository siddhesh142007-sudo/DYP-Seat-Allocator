import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Armchair, Printer, Search } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { DataTable, SearchInput, type Column, type SortState } from '../../components/ui/DataTable';
import { Select } from '../../components/ui/FormField';
import { seatingStatusTone } from '../../components/ui/tones';
import { ExportMenu } from '../../components/ExportMenu';

interface Allocation {
  studentId: string;
  rollNumber: string;
  name: string;
  classroomId: string;
  roomNumber: string;
  seatId: string;
  benchNo: number;
  row: number | null;
  col: number | null;
  seatStatus: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  publishedAt: string | null;
}

interface SeatingRun {
  id: string;
  status: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'FAILED' | 'SUPERSEDED';
  seed: string;
  generatedAt: string;
  publishedAt: string | null;
}

interface SeatingResponse {
  run: SeatingRun;
  allocations: Allocation[];
}

interface ClassroomDetail {
  classroom: {
    id: string;
    roomNumber: string;
    building: string | null;
    floor: string | null;
    status: string;
    seats: Array<{ id: string; benchNumber: number; status: string; rowNo: number | null; colNo: number | null }>;
  };
}

const DEPT_COLORS = ['#6366f1', '#16a34a', '#d97706', '#0891b2', '#db2777', '#7c3aed', '#65a30d', '#dc2626'];

function deptColor(departmentId: string, deptIds: string[]): string {
  const i = deptIds.indexOf(departmentId);
  return DEPT_COLORS[(i >= 0 ? i : 0) % DEPT_COLORS.length] ?? '#6366f1';
}

type GridCell =
  | { kind: 'occupied'; seatId: string; benchNo: number; row: number | null; col: number | null; alloc: Allocation }
  | { kind: 'empty'; seatId: string; benchNo: number; row: number | null; col: number | null }
  | { kind: 'disabled'; seatId: string; benchNo: number; row: number | null; col: number | null };

export function SeatingVisualizePage() {
  const { examId = '' } = useParams();
  const navigate = useNavigate();
  const [roomFilter, setRoomFilter] = useState('');
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<SortState>({ key: 'benchNo', order: 'asc' });
  const [selectedCell, setSelectedCell] = useState<GridCell | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const seatingQuery = useQuery({
    queryKey: ['seating', examId],
    queryFn: () => api.get<SeatingResponse>(`/seating/exams/${examId}/seating`),
    enabled: Boolean(examId),
    retry: false,
  });

  const notFound = seatingQuery.error instanceof ApiError && seatingQuery.error.status === 404;

  const allocations = useMemo(() => seatingQuery.data?.allocations ?? [], [seatingQuery.data]);
  const rooms = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of allocations) map.set(a.classroomId, a.roomNumber);
    return [...map.entries()]
      .map(([id, roomNumber]) => ({ id, roomNumber }))
      .sort((x, y) => x.roomNumber.localeCompare(y.roomNumber));
  }, [allocations]);

  const activeRoom = roomFilter || rooms[0]?.id || '';

  const classroomQuery = useQuery({
    queryKey: ['classroom', activeRoom],
    queryFn: () => api.get<ClassroomDetail>(`/classrooms/${activeRoom}`),
    enabled: Boolean(activeRoom),
  });

  const roomAllocations = useMemo(
    () => allocations.filter((a) => a.classroomId === activeRoom),
    [allocations, activeRoom],
  );

  const deptIds = useMemo(
    () => [...new Set(allocations.map((a) => a.departmentId))],
    [allocations],
  );
  const deptOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of allocations) map.set(a.departmentId, a.departmentName);
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name));
  }, [allocations]);

  const gridCells: GridCell[] = useMemo(() => {
    const seats = classroomQuery.data?.classroom.seats ?? [];
    const bySeat = new Map(roomAllocations.map((a) => [a.seatId, a]));
    const cells: GridCell[] = seats.map((s) => {
      const alloc = bySeat.get(s.id);
      const base = { seatId: s.id, benchNo: s.benchNumber, row: s.rowNo, col: s.colNo };
      if (alloc) return { kind: 'occupied', ...base, alloc };
      if (s.status !== 'AVAILABLE') return { kind: 'disabled', ...base };
      return { kind: 'empty', ...base };
    });
    // Include allocations whose seat is missing from the classroom payload (defensive).
    for (const a of roomAllocations) {
      if (!seats.some((s) => s.id === a.seatId)) {
        cells.push({ kind: 'occupied', seatId: a.seatId, benchNo: a.benchNo, row: a.row, col: a.col, alloc: a });
      }
    }
    cells.sort((x, y) => (x.row ?? 9999) - (y.row ?? 9999) || (x.col ?? x.benchNo) - (y.col ?? y.benchNo));
    return cells;
  }, [classroomQuery.data, roomAllocations]);

  const gridRows = useMemo(() => {
    const hasLayout = gridCells.some((c) => c.row !== null);
    if (hasLayout) {
      const rows = new Map<number, GridCell[]>();
      for (const c of gridCells) {
        const r = c.row ?? 9999;
        if (!rows.has(r)) rows.set(r, []);
        rows.get(r)!.push(c);
      }
      for (const cells of rows.values()) cells.sort((a, b) => (a.col ?? a.benchNo) - (b.col ?? b.benchNo));
      return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) => cells);
    }
    // Fallback: 4 benches per row, ascending bench number.
    const sorted = [...gridCells].sort((a, b) => a.benchNo - b.benchNo);
    const rows: GridCell[][] = [];
    for (let i = 0; i < sorted.length; i += 4) rows.push(sorted.slice(i, i + 4));
    return rows;
  }, [gridCells]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    return roomAllocations.filter(
      (a) =>
        (!deptFilter || a.departmentId === deptFilter) &&
        (!q || a.name.toLowerCase().includes(q) || a.rollNumber.toLowerCase().includes(q)),
    );
  }, [roomAllocations, deptFilter, debouncedSearch]);

  const sorted = useMemo(() => {
    const dir = sort.order === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case 'rollNumber':
          return dir * a.rollNumber.localeCompare(b.rollNumber);
        case 'name':
          return dir * a.name.localeCompare(b.name);
        case 'department':
          return dir * a.departmentName.localeCompare(b.departmentName);
        default:
          return dir * (a.benchNo - b.benchNo);
      }
    });
  }, [filtered, sort]);

  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);

  const columns: Column<Allocation>[] = [
    { key: 'benchNo', header: 'Bench', sortable: true, render: (a) => <span className="font-medium">#{a.benchNo}</span> },
    { key: 'rollNumber', header: 'Roll No', sortable: true },
    { key: 'name', header: 'Student', sortable: true },
    {
      key: 'department',
      header: 'Department',
      sortable: true,
      render: (a) => (
        <span className="inline-flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: deptColor(a.departmentId, deptIds) }}
            aria-hidden="true"
          />
          {a.departmentName}
        </span>
      ),
    },
  ];

  if (seatingQuery.isLoading) {
    return (
      <div className="space-y-3">
        <div className="h-6 w-64 animate-pulse rounded bg-surface" />
        <div className="grid grid-cols-4 gap-2">
          {Array.from({ length: 16 }, (_, i) => (
            <div key={i} className="h-16 animate-pulse rounded bg-surface" />
          ))}
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="space-y-4">
        <Link to={`/admin/exams/${examId}/seating`} className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to seating generation
        </Link>
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
          No seating plan exists for this exam yet. Generate a plan first, then come back to visualize it.
        </div>
        <Button variant="primary" onClick={() => navigate(`/admin/exams/${examId}/seating`)}>
          <Armchair className="h-4 w-4" aria-hidden="true" />
          Go to generation
        </Button>
      </div>
    );
  }

  if (seatingQuery.error) {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {seatingQuery.error instanceof ApiError ? seatingQuery.error.message : 'Failed to load seating'}
      </div>
    );
  }

  const run = seatingQuery.data?.run;
  const classroom = classroomQuery.data?.classroom;
  const activeRoomNumber = rooms.find((r) => r.id === activeRoom)?.roomNumber ?? '—';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Link to={`/admin/exams/${examId}/seating`} className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Seating generation
          </Link>
          <h1 className="text-xl font-semibold text-ink">
            Seating layout
            <span className="ml-2 text-sm font-normal text-ink-muted">Room {activeRoomNumber}</span>
          </h1>
          <p className="text-sm text-ink-muted">
            {run ? `Run ${run.seed || 'auto'} · ${run.status} · generated ${new Date(run.generatedAt).toLocaleString()}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Badge tone={seatingStatusTone((run?.status as 'DRAFT' | 'VALIDATED' | 'PUBLISHED') ?? 'DRAFT')}>
            {run?.status ?? ''}
          </Badge>
          <Select
            aria-label="Select classroom"
            value={activeRoom}
            onChange={(e) => {
              setRoomFilter(e.target.value);
              setPage(1);
              setSelectedCell(null);
            }}
            className="w-auto"
          >
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                Room {r.roomNumber}
              </option>
            ))}
          </Select>
          <Button onClick={() => window.print()}>
            <Printer className="h-4 w-4" aria-hidden="true" />
            Print
          </Button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs text-ink-muted">
        <span className="font-medium text-ink uppercase">Legend</span>
        {deptOptions.map((d) => (
          <span key={d.id} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: deptColor(d.id, deptIds) }} aria-hidden="true" />
            {d.name}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm border border-line bg-canvas" aria-hidden="true" />
          Empty bench
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-red-200" aria-hidden="true" />
          Disabled / unusable
        </span>
      </div>

      {/* Bench grid */}
      <section aria-label="Bench grid" className="rounded-xl border border-line bg-panel p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">
            Bench layout · Room {activeRoomNumber}
            {classroom?.building ? ` · ${classroom.building}` : ''}
            {classroom?.floor ? ` · Floor ${classroom.floor}` : ''}
          </h2>
          <p className="text-xs text-ink-muted">Hover or tap a bench for details</p>
        </div>
        {classroomQuery.isLoading ? (
          <div className="h-40 animate-pulse rounded bg-surface" />
        ) : (
          <div className="space-y-2 overflow-x-auto">
            {gridRows.map((cells, ri) => (
              <div key={ri} className="flex gap-2">
                <span className="w-8 shrink-0 self-center text-right text-[10px] text-ink-muted print:hidden">
                  {cells[0]?.row ? `R${cells[0].row}` : ''}
                </span>
                {cells.map((cell) => {
                  const color =
                    cell.kind === 'occupied' ? deptColor(cell.alloc.departmentId, deptIds) : undefined;
                  const selected = selectedCell?.seatId === cell.seatId;
                  const label =
                    cell.kind === 'occupied'
                      ? `Bench ${cell.benchNo}: ${cell.alloc.name} (${cell.alloc.rollNumber}), ${cell.alloc.departmentName}`
                      : cell.kind === 'disabled'
                        ? `Bench ${cell.benchNo}: disabled`
                        : `Bench ${cell.benchNo}: empty`;
                  return (
                    <button
                      key={cell.seatId}
                      type="button"
                      title={label}
                      aria-label={label}
                      aria-pressed={selected}
                      onClick={() => setSelectedCell(cell)}
                      className={`flex h-14 w-16 shrink-0 flex-col items-center justify-center rounded-md border text-xs leading-tight transition-shadow focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none sm:w-20 ${
                        selected ? 'ring-2 ring-brand-500' : ''
                      } ${
                        cell.kind === 'disabled'
                          ? 'border-red-300 bg-red-200 text-red-800'
                          : cell.kind === 'empty'
                            ? 'border-line bg-canvas text-ink-muted'
                            : 'border-white/20 text-white shadow-sm'
                      }`}
                      style={cell.kind === 'occupied' ? { backgroundColor: color } : undefined}
                    >
                      <span className="font-semibold">{cell.benchNo}</span>
                      <span className="max-w-full truncate px-1 text-[10px]">
                        {cell.kind === 'occupied' ? cell.alloc.rollNumber : cell.kind === 'disabled' ? '✕' : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            {gridRows.length === 0 && <p className="text-sm text-ink-muted">No seats in this room yet.</p>}
          </div>
        )}
        {selectedCell && (
          <div className="mt-3 rounded-md border border-line bg-canvas px-3 py-2 text-sm">
            {selectedCell.kind === 'occupied' ? (
              <span>
                <strong>Bench {selectedCell.benchNo}</strong> — {selectedCell.alloc.name} (
                {selectedCell.alloc.rollNumber}) · {selectedCell.alloc.departmentName}
              </span>
            ) : (
              <span>
                <strong>Bench {selectedCell.benchNo}</strong> —{' '}
                {selectedCell.kind === 'disabled' ? 'Disabled / unusable' : 'Empty'}
              </span>
            )}
          </div>
        )}
      </section>

      {/* Room table */}
      <section aria-label="Room seating table" className="space-y-1">
        <h2 className="text-sm font-semibold text-ink">
          Room {activeRoomNumber} · {roomAllocations.length} seated
        </h2>
        <DataTable
          columns={columns}
          rows={pageRows}
          keyFn={(a) => a.seatId}
          loading={classroomQuery.isLoading}
          emptyTitle="No students match"
          emptyDescription="Adjust the search or department filter."
          toolbar={
            <>
              <SearchInput
                value={search}
                onChange={(v) => {
                  setSearch(v);
                  setPage(1);
                }}
                label="Search students"
                placeholder="Name or roll number…"
              />
              <Select
                aria-label="Filter by department"
                value={deptFilter}
                onChange={(e) => {
                  setDeptFilter(e.target.value);
                  setPage(1);
                }}
                className="w-auto"
              >
                <option value="">All departments</option>
                {deptOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
              <span className="ml-auto hidden items-center gap-1.5 text-xs text-ink-muted sm:inline-flex print:hidden">
                <Search className="h-3.5 w-3.5" aria-hidden="true" />
                Roll-number search supported
              </span>
            </>
          }
          sort={sort}
          onSortChange={(s) => {
            setSort(s);
            setPage(1);
          }}
          pagination={{ page, pageSize, total: sorted.length }}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      </section>
      <div className="flex justify-end">
        <ExportMenu examId={examId} isPublished={seatingQuery.data?.run.status === 'PUBLISHED'} />
      </div>
    </div>
  );
}
