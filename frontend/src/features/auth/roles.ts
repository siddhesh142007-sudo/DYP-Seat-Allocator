import type { UserRole } from '../../api/authStore';

export function homeForRole(role: UserRole): string {
  return role === 'STUDENT' ? '/portal' : '/admin/dashboard';
}

export function roleLabel(role: UserRole): string {
  switch (role) {
    case 'SUPER_ADMIN':
      return 'Super Admin';
    case 'EXAM_ADMIN':
      return 'Exam Admin';
    case 'STUDENT':
      return 'Student';
  }
}
