import { Armchair, LogOut } from 'lucide-react';
import { Outlet } from 'react-router-dom';
import { HealthBadge } from '../HealthBadge';
import { useAuth } from '../../features/auth/AuthContext';

export function PortalShell() {
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-panel px-4">
        <Armchair className="h-5 w-5 text-brand-600" aria-hidden="true" />
        <span className="text-sm font-semibold text-ink">Exam Seating · Student Portal</span>
        <div className="ml-auto flex items-center gap-3">
          <HealthBadge />
          {user && (
            <div className="flex items-center gap-2">
              <span className="hidden text-sm text-ink sm:block">{user.name}</span>
              <button
                type="button"
                onClick={() => void logout()}
                className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Log out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 p-4 md:p-6">
        <Outlet />
      </main>
    </div>
  );
}
