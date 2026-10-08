import { createContext, useContext } from 'react';
import type { AuthUser } from '../../api/authStore';

export type AuthStatus = 'loading' | 'ready';

export interface AuthContextValue {
  user: AuthUser | null;
  /** 'loading' while the initial silent session restore is in flight. */
  status: AuthStatus;
  login: (identifier: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  /** Rotates the password and installs the fresh session the backend returns. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<AuthUser>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
