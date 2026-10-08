import type { UserRole } from '../../api/authStore';

/** DYPIT is administrator-only: everyone lands on the dashboard. */
export function homeForRole(_role: UserRole): string {
  return '/admin/dashboard';
}

export function roleLabel(role: UserRole): string {
  switch (role) {
    case 'SUPER_ADMIN':
      return 'Super Admin';
    case 'EXAM_ADMIN':
      return 'Exam Admin';
  }
}
