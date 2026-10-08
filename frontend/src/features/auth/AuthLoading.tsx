export function AuthLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-3">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand-600"
          aria-hidden="true"
        />
        <p className="text-sm text-ink-muted">Loading…</p>
      </div>
    </div>
  );
}
