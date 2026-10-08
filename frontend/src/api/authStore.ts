/** In-memory session store (access token never touches localStorage). */

export type UserRole = 'SUPER_ADMIN' | 'EXAM_ADMIN' | 'STUDENT';

export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
  role: UserRole;
  status?: 'ACTIVE' | 'INACTIVE';
  studentId: string | null;
  /** True while the account still uses its default password (rotate on first login). */
  mustChangePassword: boolean;
}

export interface Session {
  user: AuthUser | null;
  accessToken: string | null;
  /** Epoch ms when the access token expires (drives proactive refresh). */
  expiresAt: number | null;
}

const EMPTY: Session = { user: null, accessToken: null, expiresAt: null };

let session: Session = EMPTY;
const listeners = new Set<() => void>();

export function getSession(): Session {
  return session;
}

export function setSession(next: Session): void {
  session = next;
  for (const listener of listeners) listener();
}

export function clearSession(): void {
  setSession(EMPTY);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
