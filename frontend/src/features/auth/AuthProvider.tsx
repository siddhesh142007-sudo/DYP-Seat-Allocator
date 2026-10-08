import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AuthContext, type AuthContextValue, type AuthStatus } from './AuthContext';
import { clearSession, getSession, setSession, subscribe, type AuthUser } from '../../api/authStore';
import { api, tryRefresh } from '../../api/client';

interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setLocal] = useState(getSession());
  const [status, setStatus] = useState<AuthStatus>('loading');

  // Restore the session from the httpOnly refresh cookie on first mount.
  useEffect(() => {
    const unsubscribe = subscribe(() => setLocal(getSession()));
    let cancelled = false;
    void (async () => {
      await tryRefresh();
      if (!cancelled) setStatus('ready');
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Refresh the access token before it expires (60s safety margin).
  useEffect(() => {
    if (!session.expiresAt) return;
    const delay = Math.max(session.expiresAt - Date.now() - 60_000, 5_000);
    const timer = setTimeout(() => {
      void tryRefresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [session.expiresAt]);

  const login = useCallback(async (identifier: string, password: string) => {
    const body = await api.post<SessionResponse>('/auth/login', { identifier, password });
    setSession({
      user: body.user,
      accessToken: body.accessToken,
      expiresAt: Date.now() + body.expiresIn * 1000,
    });
    return body.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      clearSession();
    }
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const body = await api.post<SessionResponse>('/auth/change-password', { currentPassword, newPassword });
    setSession({
      user: body.user,
      accessToken: body.accessToken,
      expiresAt: Date.now() + body.expiresIn * 1000,
    });
    return body.user;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user: session.user, status, login, logout, changePassword }),
    [session.user, status, login, logout, changePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
