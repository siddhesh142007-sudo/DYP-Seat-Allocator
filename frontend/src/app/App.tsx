import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../features/auth/AuthProvider';
import { RequireAuth } from '../features/auth/RequireAuth';
import { HomeRedirect } from '../features/auth/HomeRedirect';
import { AdminShell } from '../components/layout/AdminShell';
import { ToastProvider } from '../components/ui/Toast';
import { LoginPage } from '../pages/LoginPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { ChangePasswordPage } from '../pages/ChangePasswordPage';
import { DashboardPage } from '../pages/admin/DashboardPage';
import { StudentsPage } from '../pages/admin/StudentsPage';
import { ClassroomsPage } from '../pages/admin/ClassroomsPage';
import { AcademicYearsPage } from '../pages/admin/AcademicYearsPage';
import { DepartmentsPage } from '../pages/admin/DepartmentsPage';
import { ExamsPage } from '../pages/admin/ExamsPage';
import { ExamDetailPage } from '../pages/admin/ExamDetailPage';
import { SeatingPage } from '../pages/admin/SeatingPage';
import { ExamSeatingPage } from '../pages/admin/ExamSeatingPage';
import { SeatingVisualizePage } from '../pages/admin/SeatingVisualizePage';
import { SeatingComparePage } from '../pages/admin/SeatingComparePage';

const ALL_ROLES = ['SUPER_ADMIN', 'EXAM_ADMIN'] as const;

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<HomeRedirect />} />
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/change-password"
              element={
                <RequireAuth roles={[...ALL_ROLES]}>
                  <ChangePasswordPage />
                </RequireAuth>
              }
            />

            <Route
              path="/admin"
              element={
                <RequireAuth roles={['SUPER_ADMIN', 'EXAM_ADMIN']}>
                  <AdminShell />
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="/admin/dashboard" replace />} />
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="students" element={<StudentsPage />} />
              <Route path="departments" element={<DepartmentsPage />} />
              <Route path="academic-years" element={<AcademicYearsPage />} />
              <Route path="classrooms" element={<ClassroomsPage />} />
              <Route path="exams" element={<ExamsPage />} />
              <Route path="exams/:examId" element={<ExamDetailPage />} />
              <Route path="seating" element={<SeatingPage />} />
              <Route path="seating/compare" element={<SeatingComparePage />} />
              <Route path="exams/:examId/seating" element={<ExamSeatingPage />} />
              <Route path="exams/:examId/seating/visualize" element={<SeatingVisualizePage />} />
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}
