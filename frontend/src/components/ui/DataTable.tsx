import type { ReactNode } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './Button';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  className?: string;
  sortable?: boolean;
}

export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
}

export interface SortState {
  key: string;
  order: 'asc' | 'desc';
}

export function DataTable<T>({
  columns,
  rows,
  keyFn,
  loading = false,
  error = null,
  onRetry,
  emptyTitle = 'Nothing here yet',
  emptyDescription = 'No records match the current filters.',
  toolbar,
  pagination,
  onPageChange,
  onPageSizeChange,
  rowActions,
  sort,
  onSortChange,
}: {
  columns: Column<T>[];
  rows: T[];
  keyFn: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  toolbar?: ReactNode;
  pagination?: PaginationState;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  rowActions?: (row: T) => ReactNode;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
}) {
  const pageCount = pagination ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize)) : 1;

  return (
    <div className="space-y-3">
      {toolbar && <div className="flex flex-wrap items-center gap-2">{toolbar}</div>}

      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface text-left text-xs font-semibold tracking-wide text-ink-muted uppercase">
                {columns.map((c) => {
                  const active = sort?.key === c.key;
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      className={cn('px-4 py-3', c.className)}
                      aria-sort={active ? (sort!.order === 'asc' ? 'ascending' : 'descending') : undefined}
                    >
                      {c.sortable && onSortChange ? (
                        <button
                          type="button"
                          onClick={() =>
                            onSortChange({ key: c.key, order: active && sort!.order === 'asc' ? 'desc' : 'asc' })
                          }
                          className="inline-flex items-center gap-1 uppercase hover:text-ink focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none"
                        >
                          {c.header}
                          {active ? (
                            sort!.order === 'asc' ? (
                              <ChevronUp className="h-3 w-3" aria-hidden="true" />
                            ) : (
                              <ChevronDown className="h-3 w-3" aria-hidden="true" />
                            )
                          ) : (
                            <ChevronDown className="h-3 w-3 opacity-40" aria-hidden="true" />
                          )}
                        </button>
                      ) : (
                        c.header
                      )}
                    </th>
                  );
                })}
                {rowActions && (
                  <th scope="col" className="px-4 py-3 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 5 }, (_, i) => (
                  <tr key={`skeleton-${i}`} className="border-b border-line last:border-0">
                    {columns.map((c) => (
                      <td key={c.key} className="px-4 py-3">
                        <div className="h-4 animate-pulse rounded bg-slate-100" />
                      </td>
                    ))}
                    {rowActions && <td className="px-4 py-3" />}
                  </tr>
                ))}

              {!loading && error && (
                <tr>
                  <td colSpan={columns.length + (rowActions ? 1 : 0)} className="px-4 py-10 text-center">
                    <div className="flex flex-col items-center gap-2 text-ink-muted">
                      <AlertTriangle className="h-6 w-6 text-amber-500" aria-hidden="true" />
                      <p className="text-sm">{error}</p>
                      {onRetry && (
                        <Button size="sm" onClick={onRetry}>
                          Retry
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              )}

              {!loading && !error && rows.length === 0 && (
                <tr>
                  <td colSpan={columns.length + (rowActions ? 1 : 0)} className="px-4 py-10 text-center">
                    <p className="text-sm font-medium text-ink">{emptyTitle}</p>
                    <p className="mt-1 text-sm text-ink-muted">{emptyDescription}</p>
                  </td>
                </tr>
              )}

              {!loading &&
                !error &&
                rows.map((row) => (
                  <tr key={keyFn(row)} className="border-b border-line transition-colors last:border-0 hover:bg-surface/60">
                    {columns.map((c) => (
                      <td key={c.key} className={cn('px-4 py-3 align-middle text-ink', c.className)}>
                        {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '')}
                      </td>
                    ))}
                    {rowActions && <td className="px-4 py-3 text-right whitespace-nowrap">{rowActions(row)}</td>}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {pagination && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-muted">
          <div className="flex items-center gap-2">
            <span>Rows per page</span>
            <select
              aria-label="Rows per page"
              value={pagination.pageSize}
              onChange={(e) => onPageSizeChange?.(Number(e.target.value))}
              className="rounded-md border border-line bg-panel px-2 py-1 text-ink focus:ring-2 focus:ring-brand-100 focus:outline-none"
            >
              {[10, 20, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span>
              {pagination.total} total · page {pagination.page} of {pageCount}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              aria-label="Previous page"
              disabled={pagination.page <= 1}
              onClick={() => onPageChange?.(pagination.page - 1)}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              size="sm"
              aria-label="Next page"
              disabled={pagination.page >= pageCount}
              onClick={() => onPageChange?.(pagination.page + 1)}
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Debounced search input styled for DataTable toolbars. */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  label = 'Search',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
      <input
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-56 rounded-md border border-line bg-panel py-2 pr-3 pl-9 text-sm text-ink placeholder:text-ink-muted focus:border-brand-500 focus:ring-2 focus:ring-brand-100 focus:outline-none"
      />
    </div>
  );
}
