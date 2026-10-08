// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../features/auth/AuthProvider';
import { LoginPage } from './LoginPage';
import { clearSession } from '../api/authStore';

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function errorBody(message: string) {
  return { error: { code: 'UNAUTHORIZED', message, details: null } };
}

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/admin/dashboard" element={<div>admin-home</div>} />
          <Route path="/portal" element={<div>student-home</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearSession();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: RequestInfo | URL) => {
    if (String(url).includes('/auth/refresh')) {
      return Promise.resolve(jsonResponse(401, errorBody('no session')));
    }
    return Promise.resolve(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'nf', details: null } }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fillAndSubmit(email: string, password: string) {
  fireEvent.change(screen.getByLabelText('Email or roll number'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('LoginPage', () => {
  it('shows a loading screen until the session restore resolves', async () => {
    let resolveRefresh!: (value: unknown) => void;
    fetchMock.mockImplementation((url: RequestInfo | URL) => {
      if (String(url).includes('/auth/refresh')) {
        return new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      }
      return Promise.resolve(jsonResponse(404, null));
    });

    renderLogin();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByLabelText('Email or roll number')).toBeNull();

    resolveRefresh(jsonResponse(401, errorBody('no session')));
    await waitFor(() => expect(screen.getByLabelText('Email or roll number')).toBeTruthy());
  });

  it('surfaces the server error message on failed login', async () => {
    fetchMock.mockImplementation((url: RequestInfo | URL) => {
      if (String(url).includes('/auth/refresh')) {
        return Promise.resolve(jsonResponse(401, errorBody('no session')));
      }
      if (String(url).includes('/auth/login')) {
        return Promise.resolve(jsonResponse(401, errorBody('Invalid email or password')));
      }
      return Promise.resolve(jsonResponse(404, null));
    });

    renderLogin();
    await screen.findByLabelText('Email or roll number');
    fillAndSubmit('admin@example.edu', 'wrong-password');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Invalid email or password');
  });

  it('submits credentials and redirects an admin to /admin/dashboard', async () => {
    fetchMock.mockImplementation((url: RequestInfo | URL) => {
      if (String(url).includes('/auth/refresh')) {
        return Promise.resolve(jsonResponse(401, errorBody('no session')));
      }
      if (String(url).includes('/auth/login')) {
        return Promise.resolve(
          jsonResponse(200, {
            accessToken: 'access-token',
            expiresIn: 900,
            user: {
              id: 'u1',
              name: 'Super Admin',
              email: 'admin@example.edu',
              role: 'SUPER_ADMIN',
              status: 'ACTIVE',
              studentId: null,
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, null));
    });

    renderLogin();
    await screen.findByLabelText('Email or roll number');
    fillAndSubmit('admin@example.edu', 'correct-password');

    await screen.findByText('admin-home');

    const loginCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/auth/login'));
    expect(loginCall).toBeDefined();
    const init = loginCall?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({
      identifier: 'admin@example.edu',
      password: 'correct-password',
    });
  });

  it('redirects an exam admin to the dashboard after login', async () => {
    fetchMock.mockImplementation((url: RequestInfo | URL) => {
      if (String(url).includes('/auth/refresh')) {
        return Promise.resolve(jsonResponse(401, errorBody('no session')));
      }
      if (String(url).includes('/auth/login')) {
        return Promise.resolve(
          jsonResponse(200, {
            accessToken: 'access-token',
            expiresIn: 900,
            user: {
              id: 'u2',
              name: 'Exam Admin',
              email: 'ea@test.local',
              role: 'EXAM_ADMIN',
              status: 'ACTIVE',
              studentId: null,
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, null));
    });

    renderLogin();
    await screen.findByLabelText('Email or roll number');
    fillAndSubmit('ea@test.local', 'admin-password');

    await screen.findByText('admin-home');
  });
});
