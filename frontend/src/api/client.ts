/** API client: typed fetch wrapper speaking the {error:{code,message,details}} envelope. */

import { clearSession, getSession, setSession, type AuthUser } from './authStore';

const RAW_BASE = import.meta.env.VITE_API_URL ?? '';
export const API_BASE = RAW_BASE.replace(/\/$/, '');

export interface ApiErrorEnvelope {
  error: { code: string; message: string; details: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
}

/**
 * Exchanges the httpOnly refresh cookie for a new access token (called on
 * startup, proactively before expiry, and after a 401). Returns whether a
 * session could be established.
 */
export async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return false;
    const body = (await res.json()) as SessionResponse;
    setSession({
      user: body.user,
      accessToken: body.accessToken,
      expiresAt: Date.now() + body.expiresIn * 1000,
    });
    return true;
  } catch {
    return false;
  }
}

function isAuthPath(path: string): boolean {
  return path.startsWith('/auth/');
}

async function request<T>(path: string, init?: RequestInit, allowRefresh = true): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  const token = getSession().accessToken;
  if (token && !isAuthPath(path)) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (res.status === 401 && allowRefresh && !isAuthPath(path)) {
    if (await tryRefresh()) {
      return request<T>(path, init, false);
    }
    clearSession();
  }

  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const envelope = body as ApiErrorEnvelope | null;
    const err = envelope?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN_ERROR',
      err?.message ?? `Request failed with status ${res.status}`,
      err?.details ?? null,
    );
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  delete: <T>(path: string) => request<T>(path),
  /** Multipart upload (browser sets the boundary; JSON content-type is skipped). */
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
  /** Authenticated file download; returns the raw bytes for a save trigger. */
  download: async (path: string): Promise<Blob> => {
    const headers: Record<string, string> = {};
    const token = getSession().accessToken;
    if (token && !isAuthPath(path)) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/api/v1${path}`, { headers, credentials: 'include' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiErrorEnvelope | null;
      throw new ApiError(res.status, body?.error.code ?? 'UNKNOWN_ERROR', body?.error.message ?? 'Download failed');
    }
    return res.blob();
  },
};
