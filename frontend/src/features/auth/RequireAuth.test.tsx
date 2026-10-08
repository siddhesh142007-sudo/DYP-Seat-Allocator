// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './AuthProvider';
import { RequireAuth } from './RequireAuth';
import { clearSession, setSession, type AuthUser } from '../../api/authStore';

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const admin: AuthUser = {
  id: 'admin-1',
  name: 'Admin User',
  email: 'admin@example.edu',
  role: 'SUPER_ADMIN',
  status: 'ACTIVE',
  studentId: null,
  mustChangePassword: false,
};

const examAdmin: AuthUser = {
  id: 'exam-admin-1',
  name: 'Exam Admin User',
  email: 'ea@test.local',
  role: 'EXAM_ADMIN',
  status: 'ACTIVE',
  studentId: null,
  mustChangePassword: false,
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route
            path="/admin"
            element={
              <RequireAuth roles={['SUPER_ADMIN', 'EXAM_ADMIN']}>
                <div>admin-secure</div>
              </RequireAuth>
            }
          />
          <Route path="/admin/dashboard" element={<div>admin-home</div>} />
          <Route
            path="/super"
            element={
              <RequireAuth roles={['SUPER_ADMIN']}>
                <div>super-secure</div>
              </RequireAuth>
            }
          />
          <Route path="/login" element={<div>login-page</div>} />
          <Route
            path="/change-password"
            element={
              <RequireAuth roles={['SUPER_ADMIN', 'EXAM_ADMIN']}>
                <div>change-password-page</div>
              </RequireAuth>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearSession();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'none', details: null } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RequireAuth', () => {
  it('lets an authenticated admin into admin routes', async () => {
    setSession({ user: admin, accessToken: 't', expiresAt: Date.now() + 600_000 });
    renderAt('/admin');
    await screen.findByText('admin-secure');
  });

  it('redirects unauthenticated visitors to /login', async () => {
    renderAt('/admin');
    await screen.findByText('login-page');
    expect(screen.queryByText('admin-secure')).toBeNull();
  });

  it('sends an EXAM_ADMIN to their own home from a SUPER_ADMIN-only route', async () => {
    setSession({ user: examAdmin, accessToken: 't', expiresAt: Date.now() + 600_000 });
    renderAt('/super');
    await screen.findByText('admin-home');
    expect(screen.queryByText('super-secure')).toBeNull();
  });

  it('lets a SUPER_ADMIN into a SUPER_ADMIN-only route', async () => {
    setSession({ user: admin, accessToken: 't', expiresAt: Date.now() + 600_000 });
    renderAt('/super');
    await screen.findByText('super-secure');
  });

  it('forces a must-change-password user to /change-password', async () => {
    setSession({
      user: { ...admin, mustChangePassword: true },
      accessToken: 't',
      expiresAt: Date.now() + 600_000,
    });
    renderAt('/admin');
    await screen.findByText('change-password-page');
    expect(screen.queryByText('admin-secure')).toBeNull();
  });

  it('lets a must-change-password user reach /change-password itself', async () => {
    setSession({
      user: { ...admin, mustChangePassword: true },
      accessToken: 't',
      expiresAt: Date.now() + 600_000,
    });
    renderAt('/change-password');
    await screen.findByText('change-password-page');
  });
});
