import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarClock,
  DoorOpen,
  GraduationCap,
  LayoutGrid,
  Users,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, ApiError } from '../../api/client';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { statusTone, seatingStatusTone, type BadgeTone } from '../../components/ui/tones';
import type { ExamRow } from './ExamsPage';

interface SummaryData {
  summary: {
    totalStudents: number;
    totalDepartments: number;
    totalClassrooms: number;
    availableSeats: number;
    upcomingExams: number;
    generatedSeatingPlans: number;
    allocationConflicts: number;
  };
}

interface ChartsData {
  studentsPerDepartment: Array<{ code: string; name: string; count: number }>;
  seatsVsStudents: Array<{
    examId: string;
    subject: string;
    examDate: string;
    eligibleCount: number;
    availableSeats: number;
  }>;
  plansByStatus: Array<{ status: string; count: number }>;
}

const PLAN_TONES: Record<string, string> = {
  NOT_GENERATED: '#94a3b8',
  DRAFT: '#d97706',
  VALIDATED: '#6366f1',
  PUBLISHED: '#16a34a',
};

const PLAN_LABELS: Record<string, string> = {
  NOT_GENERATED: 'Not generated',
  DRAFT: 'Draft',
  VALIDATED: 'Validated',
  PUBLISHED: 'Published',
};

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: number | string;
  hint: string;
  icon: typeof Users;
  tone?: 'default' | 'danger';
}) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</p>
          <p className={`mt-1 text-2xl font-semibold ${tone === 'danger' ? 'text-red-600' : 'text-ink'}`}>{value}</p>
          <p className="mt-1 truncate text-xs text-ink-muted">{hint}</p>
        </div>
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
            tone === 'danger' ? 'bg-red-50 text-red-600' : 'bg-brand-50 text-brand-600'
          }`}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <div className="mt-3 h-64">{children}</div>
    </div>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();

  const summaryQuery = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: () => api.get<SummaryData>('/dashboard/summary'),
    refetchInterval: 60_000,
  });
  const chartsQuery = useQuery({
    queryKey: ['dashboard-charts'],
    queryFn: () => api.get<ChartsData>('/dashboard/charts'),
    refetchInterval: 60_000,
  });
  const upcomingQuery = useQuery({
    queryKey: ['dashboard-upcoming-exams'],
    queryFn: () =>
      api.get<{ items: ExamRow[] }>('/exams?status=PLANNED&sort=examDate&order=asc&page=1&pageSize=25'),
    refetchInterval: 60_000,
  });

  const err = summaryQuery.error;
  if (err) {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {err instanceof ApiError ? err.message : 'Failed to load dashboard'}
        <button type="button" className="ml-3 underline" onClick={() => void summaryQuery.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  const s = summaryQuery.data?.summary;
  const charts = chartsQuery.data;
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = (upcomingQuery.data?.items ?? [])
    .filter((e) => e.examDate >= today)
    .slice(0, 8);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">Dashboard</h1>
          <p className="text-sm text-ink-muted">Institution at a glance: people, rooms, exams and seating plans.</p>
        </div>
        <Button variant="ghost" onClick={() => navigate('/admin/seating')}>
          Open seating plans
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <dl className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
        <MetricCard
          label="Total students"
          value={s ? s.totalStudents : '—'}
          hint="Active enrolments"
          icon={GraduationCap}
        />
        <MetricCard
          label="Departments"
          value={s ? s.totalDepartments : '—'}
          hint="Active departments"
          icon={Building2}
        />
        <MetricCard label="Classrooms" value={s ? s.totalClassrooms : '—'} hint="Available rooms" icon={DoorOpen} />
        <MetricCard label="Available seats" value={s ? s.availableSeats : '—'} hint="In available rooms" icon={LayoutGrid} />
        <MetricCard label="Upcoming exams" value={s ? s.upcomingExams : '—'} hint="Planned, from today" icon={CalendarClock} />
        <MetricCard
          label="Seating plans"
          value={s ? s.generatedSeatingPlans : '—'}
          hint="Any non-empty status"
          icon={Users}
        />
        <MetricCard
          label="Allocation conflicts"
          value={s ? s.allocationConflicts : '—'}
          hint={s && s.allocationConflicts > 0 ? 'Exams that cannot be seated' : 'All upcoming exams feasible'}
          icon={AlertTriangle}
          tone={s && s.allocationConflicts > 0 ? 'danger' : 'default'}
        />
      </dl>

      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Students per department">
          {chartsQuery.isLoading ? (
            <div className="h-full animate-pulse rounded bg-surface" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={charts?.studentsPerDepartment.slice(0, 8) ?? []}
                layout="vertical"
                margin={{ top: 0, right: 16, bottom: 0, left: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={120}
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
                />
                <Tooltip cursor={{ fill: '#f1f5f9' }} />
                <Bar dataKey="count" name="Students" fill="#6366f1" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Seats vs students (upcoming exams)">
          {chartsQuery.isLoading ? (
            <div className="h-full animate-pulse rounded bg-surface" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={
                  charts?.seatsVsStudents.map((e) => ({
                    ...e,
                    label: e.subject.length > 12 ? `${e.subject.slice(0, 11)}…` : e.subject,
                  })) ?? []
                }
                margin={{ top: 0, right: 8, bottom: 0, left: -16 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#64748b' }} interval={0} angle={-20} height={44} textAnchor="end" />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }} allowDecimals={false} />
                <Tooltip cursor={{ fill: '#f1f5f9' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="eligibleCount" name="Eligible students" fill="#6366f1" radius={[4, 4, 0, 0]} />
                <Bar dataKey="availableSeats" name="Available seats" fill="#16a34a" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Plans by status">
          {chartsQuery.isLoading ? (
            <div className="h-full animate-pulse rounded bg-surface" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={(charts?.plansByStatus ?? []).filter((p) => p.count > 0)}
                  dataKey="count"
                  nameKey="status"
                  innerRadius={52}
                  outerRadius={84}
                  paddingAngle={2}
                >
                  {(charts?.plansByStatus ?? [])
                    .filter((p) => p.count > 0)
                    .map((p) => (
                      <Cell key={p.status} fill={PLAN_TONES[p.status] ?? '#94a3b8'} />
                    ))}
                </Pie>
                <Tooltip formatter={(value, name) => [String(value), PLAN_LABELS[String(name)] ?? String(name)]} />
                <Legend formatter={(value) => PLAN_LABELS[String(value)] ?? String(value)} wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      <div className="rounded-xl border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">Upcoming exams</h2>
          <Button size="sm" variant="ghost" onClick={() => navigate('/admin/exams')}>
            View all
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        {upcomingQuery.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-8 animate-pulse rounded bg-surface" />
            ))}
          </div>
        ) : upcoming.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">No upcoming exams scheduled.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface text-left text-xs font-semibold tracking-wide text-ink-muted uppercase">
                  <th scope="col" className="px-4 py-2.5">
                    Subject
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    Date
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    Time
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    Seating
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    <span className="sr-only">Actions</span>
                      </th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0 hover:bg-surface/60">
                    <td className="px-4 py-2.5 font-medium text-ink">
                      {e.subject}
                      {e.paperCode && <span className="ml-2 text-xs text-ink-muted">{e.paperCode}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-ink-muted">{e.examDate}</td>
                    <td className="px-4 py-2.5 text-ink-muted">
                      {e.startTime} – {e.endTime}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={statusTone(e.status) as BadgeTone}>{e.status}</Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex gap-1">
                        <Badge tone={seatingStatusTone(e.seatingStatus)}>
                          {e.seatingStatus.replace('_', ' ')}
                        </Badge>
                        {e.isStale && <Badge tone="warning">Stale</Badge>}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button size="sm" variant="ghost" onClick={() => navigate(`/admin/exams/${e.id}/seating`)}>
                        Manage seating
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
