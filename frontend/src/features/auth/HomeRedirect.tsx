import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { AuthLoading } from './AuthLoading';
import { homeForRole } from './roles';

/** "/" landing: role-based redirect (admins → /admin, students → /portal). */
export function HomeRedirect() {
  const { user, status } = useAuth();
  if (status === 'loading') return <AuthLoading />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={homeForRole(user.role)} replace />;
}
