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

const student: AuthUser = {
  id: 'student-1',
  name: 'Student User',
  email: null,
  role: 'STUDENT',
  status: 'ACTIVE',
  studentId: 's-1',
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
            path="/portal"
            element={
              <RequireAuth roles={['STUDENT']}>
                <div>portal-secure</div>
              </RequireAuth>
            }
          />
          <Route path="/login" element={<div>login-page</div>} />
          <Route
            path="/change-password"
            element={
              <RequireAuth roles={['SUPER_ADMIN', 'EXAM_ADMIN', 'STUDENT']}>
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

  it('sends a student to their portal when they stray into /admin', async () => {
    setSession({ user: student, accessToken: 't', expiresAt: Date.now() + 600_000 });
    renderAt('/admin');
    await screen.findByText('portal-secure');
    expect(screen.queryByText('admin-secure')).toBeNull();
  });

  it('sends an admin to /admin/dashboard when they stray into /portal', async () => {
    setSession({ user: admin, accessToken: 't', expiresAt: Date.now() + 600_000 });
    renderAt('/portal');
    await screen.findByText('admin-home');
    expect(screen.queryByText('portal-secure')).toBeNull();
  });

  it('redirects a logged-out visitor away from /portal', async () => {
    renderAt('/portal');
    await screen.findByText('login-page');
    expect(screen.queryByText('portal-secure')).toBeNull();
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
