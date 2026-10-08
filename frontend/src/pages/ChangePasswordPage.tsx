import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import { useAuth } from '../features/auth/AuthContext';
import { homeForRole } from '../features/auth/roles';
import { ApiError } from '../api/client';
import { Button } from '../components/ui/Button';
import { FormField, Input } from '../components/ui/FormField';
import { useToast } from '../components/ui/toastContext';

export function ChangePasswordPage() {
  const { user, changePassword } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});
  const [busy, setBusy] = useState(false);

  const forced = user?.mustChangePassword ?? false;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const errs: typeof fieldErrors = {};
    if (!current) errs.current = 'Enter your current password';
    if (next.length < 8) errs.next = 'Must be at least 8 characters';
    if (next !== confirm) errs.confirm = 'Passwords do not match';
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      toast(forced ? 'Password set. Welcome aboard!' : 'Password changed');
      navigate(homeForRole(user!.role), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
        setError(err.message);
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface p-4">
      <div className="w-full max-w-md rounded-xl border border-line bg-panel p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50">
            <KeyRound className="h-5 w-5 text-brand-600" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-ink">
              {forced ? 'Set your password' : 'Change password'}
            </h1>
            <p className="text-sm text-ink-muted">
              {forced
                ? 'Your account uses a default password. Choose a new one to continue.'
                : 'Choose a new password for your account.'}
            </p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <FormField label="Current password" required error={fieldErrors.current}>
            {(a) => (
              <Input
                {...a}
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            )}
          </FormField>

          <FormField label="New password" required error={fieldErrors.next} hint="At least 8 characters.">
            {(a) => (
              <Input
                {...a}
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            )}
          </FormField>

          <FormField label="Confirm new password" required error={fieldErrors.confirm}>
            {(a) => (
              <Input
                {...a}
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            )}
          </FormField>

          <Button type="submit" variant="primary" loading={busy} className="w-full">
            {forced ? 'Set password & continue' : 'Change password'}
          </Button>
        </form>
      </div>
    </div>
  );
}
