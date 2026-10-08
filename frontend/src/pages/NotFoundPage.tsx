import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-surface p-4 text-center">
      <p className="text-sm font-semibold text-brand-600">404</p>
      <h1 className="text-3xl font-semibold text-ink">Page not found</h1>
      <p className="max-w-md text-sm text-ink-muted">
        The page you are looking for does not exist or has moved.
      </p>
      <Link
        to="/"
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        Go home
      </Link>
    </div>
  );
}
