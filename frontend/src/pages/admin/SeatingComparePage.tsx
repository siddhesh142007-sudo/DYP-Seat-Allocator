import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRightLeft, PlusCircle, MinusCircle } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { DataTable, type Column, type SortState } from '../../components/ui/DataTable';
import { Select } from '../../components/ui/FormField';
import { compareAllocations, type CompareAllocation, type CompareResult } from '../../lib/compare';
import type { ExamRow } from './ExamsPage';

interface SeatingRun {
  id: string;
  status: 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'FAILED' | 'SUPERSEDED';
  seed: string;
  generatedAt: string;
  publishedAt: string | null;
}

interface Allocation extends CompareAllocation {
  classroomId: string;
  seatId: string;
  departmentId: string;
  departmentName: string;
}

interface SeatingResponse {
  run: SeatingRun;
  allocations: Allocation[];
}

const PAGE_SIZE = 25;

function queryErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return 'No seating plan exists for this exam yet — generate one first.';
    return err.message;
  }
  return 'Failed to load seating';
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className={`text-2xl font-semibold ${tone ?? 'text-ink'}`}>{value}</div>
      <div className="mt-0.5 text-xs text-ink-muted">{label}</div>
    </div>
  );
}

export function SeatingComparePage() {
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: 'rollNumber', order: 'asc' });

  const examsQuery = useQuery({
    queryKey: ['compare-exams'],
    queryFn: () =>
      api.get<{ items: ExamRow[] }>(`/exams?page=1&pageSize=100&sort=examDate&order=asc`),
    retry: false,
  });

  const exams = useMemo(() => examsQuery.data?.items ?? [], [examsQuery.data]);
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    const [first, second] = exams;
    if (!first) return;
    seeded.current = true;
    setLeftId(first.id);
    if (second) setRightId(second.id);
  }, [exams]);

  const different = Boolean(leftId) && leftId !== rightId;

  const leftQuery = useQuery({
    queryKey: ['seating-compare', leftId],
    queryFn: () => api.get<SeatingResponse>(`/seating/exams/${leftId}/seating`),
    enabled: Boolean(leftId),
    retry: false,
  });

  const rightQuery = useQuery({
    queryKey: ['seating-compare', rightId],
    queryFn: () => api.get<SeatingResponse>(`/seating/exams/${rightId}/seating`),
    enabled: different,
    retry: false,
  });

  const diff: CompareResult | null =
    leftQuery.data && rightQuery.data
      ? compareAllocations(leftQuery.data.allocations, rightQuery.data.allocations)
      : null;

  const sortedMoved = useMemo(() => {
    if (!diff) return [];
    const rows = [...diff.moved];
    const dir = sort.order === 'asc' ? 1 : -1;
    rows.sort((a, b) => dir * a.rollNumber.localeCompare(b.rollNumber));
    return rows;
  }, [diff, sort]);

  const pagedMoved = sortedMoved.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [leftId, rightId]);

  const examLabel = (x: ExamRow) =>
    `${x.subject}${x.paperCode ? ` · ${x.paperCode}` : ''} · ${x.examDate}`;

  const columns: Column<(typeof sortedMoved)[number]>[] = [
    { key: 'rollNumber', header: 'Roll No', sortable: true },
    {
      key: 'name',
      header: 'Student',
      render: (x) => (
        <div>
          <span className="font-medium">{x.name}</span>
          <span className="block text-xs text-ink-muted">{x.departmentCode}</span>
        </div>
      ),
    },
    {
      key: 'from',
      header: 'Paper A seat',
      render: (x) => (
        <span className="whitespace-nowrap">
          Room {x.from.roomNumber} / Bench {x.from.benchNo}
        </span>
      ),
    },
    {
      key: 'to',
      header: 'Paper B seat',
      render: (x) => (
        <span className="whitespace-nowrap">
          Room {x.to.roomNumber} / Bench {x.to.benchNo}
        </span>
      ),
    },
    {
      key: 'change',
      header: 'Change',
      render: (x) =>
        x.roomChanged ? <Badge tone="brand">Room + bench</Badge> : <Badge tone="warning">Bench only</Badge>,
    },
  ];

  const loading = leftQuery.isLoading || (different && rightQuery.isLoading);
  const error = leftQuery.error ?? (different ? rightQuery.error : null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <Link
            to="/admin/seating"
            className="mb-1 inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Seating Plans
          </Link>
          <h1 className="text-xl font-semibold text-ink">Compare two papers</h1>
          <p className="text-sm text-ink-muted">
            See how each student&apos;s room and bench changed between two papers — history-aware
            generation should reshuffle most seats.
          </p>
        </div>
        <Button variant="ghost" onClick={() => window.print()} aria-label="Print comparison">
          Print
        </Button>
      </div>

      <div className="grid gap-3 rounded-lg border border-line bg-panel p-4 sm:grid-cols-[1fr_auto_1fr] sm:items-end print:hidden">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-muted">Paper A (first exam)</span>
          <Select value={leftId} onChange={(e) => setLeftId(e.target.value)} aria-label="First exam">
            <option value="">Select an exam…</option>
            {exams.map((x) => (
              <option key={x.id} value={x.id}>
                {examLabel(x)}
              </option>
            ))}
          </Select>
        </label>
        <div className="hidden justify-center pb-2 sm:flex" aria-hidden="true">
          <ArrowRightLeft className="h-4 w-4 text-ink-muted" />
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-muted">Paper B (second exam)</span>
          <Select value={rightId} onChange={(e) => setRightId(e.target.value)} aria-label="Second exam">
            <option value="">Select an exam…</option>
            {exams.map((x) => (
              <option key={x.id} value={x.id} disabled={x.id === leftId}>
                {examLabel(x)}
              </option>
            ))}
          </Select>
        </label>
        {!different && (
          <p className="text-xs text-ink-muted sm:col-span-3">
            Pick two different papers to compare.
          </p>
        )}
      </div>

      {loading && (
        <div className="grid gap-3 sm:grid-cols-4" aria-busy="true" aria-label="Loading comparison">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg border border-line bg-panel" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
          role="alert"
        >
          {queryErrorMessage(error)}
        </div>
      )}

      {!loading && !error && different && diff && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryCard label="Students moved" value={diff.moved.length} tone="text-brand-600" />
            <SummaryCard label="Room + bench changes" value={diff.roomMoves} />
            <SummaryCard label="Unchanged seats" value={diff.sameCount} tone="text-emerald-700" />
            <SummaryCard
              label="Added / removed"
              value={diff.added.length + diff.removed.length}
              tone="text-amber-600"
            />
          </div>

          <DataTable
            columns={columns}
            rows={pagedMoved}
            keyFn={(x) => x.studentId}
            emptyTitle="No student changed seats"
            emptyDescription="Both papers have an identical seating layout for every student."
            sort={sort}
            onSortChange={setSort}
            pagination={{ page, pageSize: PAGE_SIZE, total: sortedMoved.length }}
            onPageChange={setPage}
          />

          {(diff.added.length > 0 || diff.removed.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {diff.removed.length > 0 && (
                <div className="rounded-lg border border-line bg-panel p-4">
                  <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink">
                    <MinusCircle className="h-4 w-4 text-red-600" aria-hidden="true" />
                    Seated in A, not in B ({diff.removed.length})
                  </h2>
                  <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
                    {diff.removed.map((x) => (
                      <li key={x.studentId} className="flex justify-between gap-2">
                        <span>{x.name}</span>
                        <span className="text-ink-muted">
                          {x.rollNumber} · Room {x.roomNumber}/{x.benchNo}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {diff.added.length > 0 && (
                <div className="rounded-lg border border-line bg-panel p-4">
                  <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-ink">
                    <PlusCircle className="h-4 w-4 text-emerald-700" aria-hidden="true" />
                    Seated in B, not in A ({diff.added.length})
                  </h2>
                  <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
                    {diff.added.map((x) => (
                      <li key={x.studentId} className="flex justify-between gap-2">
                        <span>{x.name}</span>
                        <span className="text-ink-muted">
                          {x.rollNumber} · Room {x.roomNumber}/{x.benchNo}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <p className="text-xs text-ink-muted">
            Comparing run {leftQuery.data?.run.id.slice(0, 8)} (
            {leftQuery.data?.run.status}) with run {rightQuery.data?.run.id.slice(0, 8)} (
            {rightQuery.data?.run.status}).
          </p>
        </>
      )}

      {!loading && !error && (!leftId || !different) && exams.length > 0 && (
        <div className="rounded-lg border border-line bg-panel p-6 text-center text-sm text-ink-muted">
          Select two exams with a generated seating plan to see how seats moved.
        </div>
      )}

      {!loading && examsQuery.isSuccess && exams.length === 0 && (
        <div className="rounded-lg border border-line bg-panel p-6 text-center text-sm text-ink-muted">
          No exams exist yet. Create an exam and generate its seating plan first.
        </div>
      )}

      {!loading && examsQuery.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
          {queryErrorMessage(examsQuery.error)}
        </div>
      )}
    </div>
  );
}
