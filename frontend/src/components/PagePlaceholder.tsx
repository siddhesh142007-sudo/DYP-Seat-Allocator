import type { ReactNode } from 'react';

/**
 * Placeholder page for routes that arrive in later phases.
 * Phase 1 ships navigation structure only — no fake functionality.
 */
export function PagePlaceholder({
  title,
  description,
  phase,
  children,
}: {
  title: string;
  description: string;
  phase: string;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="rounded-xl border border-dashed border-line bg-panel p-8 text-center">
        <span className="mb-4 inline-block rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
          {phase}
        </span>
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        <p className="mt-2 text-sm text-ink-muted">{description}</p>
        {children}
      </div>
    </div>
  );
}
