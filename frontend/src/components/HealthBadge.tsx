import { useHealth } from '../hooks/useHealth';
import { cn } from '../lib/utils';

export function HealthBadge() {
  const { data, isError, isPending } = useHealth();

  const label = isPending ? 'Checking…' : isError ? 'API unreachable' : `API ${data.status}`;
  const up = !isError && data?.status === 'ok';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        up
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-amber-200 bg-amber-50 text-amber-700',
      )}
      role="status"
      aria-live="polite"
    >
      <span
        className={cn('h-1.5 w-1.5 rounded-full', up ? 'bg-emerald-500' : 'bg-amber-500')}
        aria-hidden="true"
      />
      {label}
      {!isError && !isPending && (
        <span className="text-ink-muted">· db {data.db} · {data.dbLatencyMs}ms</span>
      )}
    </span>
  );
}
