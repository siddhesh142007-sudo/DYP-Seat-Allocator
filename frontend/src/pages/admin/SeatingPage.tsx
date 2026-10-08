import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Armchair, GitCompareArrows, LayoutGrid } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { seatingStatusTone, statusTone } from '../../components/ui/tones';
import { DataTable, SearchInput, type Column, type SortState } from '../../components/ui/DataTable';
import { Select } from '../../components/ui/FormField';
import type { ExamRow } from './ExamsPage';

export function SeatingPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sort, setSort] = useState<SortState>({ key: 'examDate', order: 'asc' });
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedSearch) p.set('search', debouncedSearch);
    if (statusFilter) p.set('status', statusFilter);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    p.set('sort', sort.key);
    p.set('order', sort.order);
    return p.toString();
  }, [debouncedSearch, statusFilter, page, pageSize, sort]);

  const examsQuery = useQuery({
    queryKey: ['seating-hub-exams', params],
    queryFn: () =>
      api.get<{ items: ExamRow[]; total: number; page: number; pageSize: number }>(`/exams?${params}`),
    placeholderData: (prev) => prev,
  });

  const columns: Column<ExamRow>[] = [
    {
      key: 'subject',
      header: 'Exam',
      sortable: true,
      render: (x) => (
        <div>
          <span className="font-medium">{x.subject}</span>
          {x.paperCode && <span className="ml-2 text-xs text-ink-muted">{x.paperCode}</span>}
          <span className="block text-xs text-ink-muted">{x.academicYear?.name ?? ''}</span>
        </div>
      ),
    },
    { key: 'examDate', header: 'Date', sortable: true },
    { key: 'time', header: 'Time', render: (x) => `${x.startTime} – ${x.endTime}` },
    { key: 'status', header: 'Exam', sortable: true, render: (x) => <Badge tone={statusTone(x.status)}>{x.status}</Badge> },
    {
      key: 'seating',
      header: 'Seating plan',
      render: (x) => (
        <span className="inline-flex gap-1">
          <Badge tone={seatingStatusTone(x.seatingStatus)}>{x.seatingStatus.replace('_', ' ')}</Badge>
          {x.isStale && <Badge tone="warning">Stale</Badge>}
        </span>
      ),
    },
    { key: 'registrations', header: 'Registered', render: (x) => x.registrationCount ?? '—' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Seating Plans</h1>
          <p className="text-sm text-ink-muted">
            Pick an exam to generate, validate, publish or visualize its seating plan.
          </p>
        </div>
        <Button size="sm" onClick={() => navigate('/admin/seating/compare')}>
          <GitCompareArrows className="h-4 w-4" aria-hidden="true" />
          Compare papers
        </Button>
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
        emptyDescription="Create an exam first, then generate a seating plan for it."
        toolbar={
          <>
            <SearchInput
              value={search}
              onChange={setSearch}
              label="Search exams"
              placeholder="Subject or paper code…"
            />
            <Select
              aria-label="Filter by exam status"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="w-auto"
            >
              <option value="">All exams</option>
              <option value="PLANNED">Planned</option>
              <option value="COMPLETED">Completed</option>
              <option value="CANCELLED">Cancelled</option>
            </Select>
          </>
        }
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
        rowActions={(x) => (
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Generate seating for ${x.subject}`}
              onClick={() => navigate(`/admin/exams/${x.id}/seating`)}
            >
              <Armchair className="h-4 w-4" aria-hidden="true" />
              Manage
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`View seating layout for ${x.subject}`}
              disabled={x.seatingStatus === 'NOT_GENERATED'}
              onClick={() => navigate(`/admin/exams/${x.id}/seating/visualize`)}
            >
              <LayoutGrid className="h-4 w-4" aria-hidden="true" />
              View
            </Button>
          </div>
        )}
      />
    </div>
  );
}
