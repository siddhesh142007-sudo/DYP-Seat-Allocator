import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Armchair,
  Building2,
  CalendarRange,
  ClipboardList,
  DoorOpen,
  GitCompareArrows,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { HealthBadge } from '../HealthBadge';
import { useAuth } from '../../features/auth/AuthContext';
import { roleLabel } from '../../features/auth/roles';

const NAV_ITEMS = [
  { to: '/admin/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/admin/students', label: 'Students', icon: GraduationCap },
  { to: '/admin/departments', label: 'Departments', icon: Building2 },
  { to: '/admin/academic-years', label: 'Academic Years', icon: CalendarRange },
  { to: '/admin/classrooms', label: 'Classrooms', icon: DoorOpen },
  { to: '/admin/exams', label: 'Exams', icon: ClipboardList },
  { to: '/admin/seating', label: 'Seating Plans', icon: Armchair, end: true },
  { to: '/admin/seating/compare', label: 'Compare Papers', icon: GitCompareArrows },
] as const;

function SidebarLink({
  to,
  label,
  icon: Icon,
  collapsed,
  end = false,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  collapsed: boolean;
  end?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          'focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none',
          isActive
            ? 'bg-brand-600 text-white'
            : 'text-sidebar-ink hover:bg-sidebar-hover hover:text-white',
          collapsed && 'justify-center px-2',
        )
      }
    >
      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );
}

export function AdminShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { user, logout } = useAuth();

  const current =
    NAV_ITEMS.filter((i) => location.pathname === i.to || location.pathname.startsWith(`${i.to}/`))
      .sort((a, b) => b.to.length - a.to.length)[0]?.label ?? 'Exam Seating';

  return (
    <div className="flex h-full min-h-screen bg-surface">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 flex-col bg-sidebar transition-[width] duration-200 md:flex',
          collapsed ? 'w-16' : 'w-64',
        )}
      >
        <div className="flex h-14 items-center justify-between border-b border-white/10 px-4">
          {!collapsed && (
            <span className="text-sm font-semibold tracking-wide text-white">Exam Seating</span>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="rounded p-1.5 text-sidebar-ink hover:bg-sidebar-hover hover:text-white focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Admin navigation">
          {NAV_ITEMS.map((item) => (
            <SidebarLink key={item.to} {...item} collapsed={collapsed} />
          ))}
        </nav>
        <div className="border-t border-white/10 p-3 text-xs text-sidebar-ink">
          {!collapsed && 'v0.1.0'}
        </div>
      </aside>

      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-sidebar">
            <div className="flex h-14 items-center justify-between border-b border-white/10 px-4">
              <span className="text-sm font-semibold text-white">Exam Seating</span>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close sidebar"
                className="rounded p-1.5 text-sidebar-ink hover:bg-sidebar-hover hover:text-white"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="Admin navigation">
              {NAV_ITEMS.map((item) => (
                <SidebarLink
                  key={item.to}
                  {...item}
                  collapsed={false}
                  onNavigate={() => setMobileOpen(false)}
                />
              ))}
            </nav>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-panel px-4">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open sidebar"
            className="rounded p-1.5 text-ink-muted hover:bg-surface focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:outline-none md:hidden"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <nav aria-label="Breadcrumb" className="min-w-0">
            <ol className="flex items-center gap-2 text-sm">
              <li className="text-ink-muted">Admin</li>
              <li aria-hidden="true" className="text-ink-muted">
                /
              </li>
              <li className="truncate font-medium text-ink">{current}</li>
            </ol>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <HealthBadge />
            {user && (
              <div className="flex items-center gap-2">
                <span className="hidden text-sm text-ink md:block">{user.name}</span>
                <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">
                  {roleLabel(user.role)}
                </span>
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

        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
