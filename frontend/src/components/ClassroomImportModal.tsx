import { useRef, useState, type ChangeEvent } from 'react';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { api, ApiError, API_BASE } from '../api/client';
import { getSession } from '../api/authStore';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { useToast } from './ui/toastContext';

interface ImportRowReport {
  row: number;
  roomNumber?: string;
  rollNumber?: string;
  name?: string;
  action: 'create' | 'update' | 'skip' | 'error';
  errors: string[];
}

interface ImportReport {
  dryRun: boolean;
  valid: boolean;
  summary: { total: number; created: number; updated?: number; skipped: number; errors: number };
  rows: ImportRowReport[];
}

async function downloadClassroomTemplate(format: 'csv' | 'xlsx') {
  const headers: Record<string, string> = {};
  const token = getSession().accessToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/v1/classrooms/import/template?format=${format}`, {
    headers,
    credentials: 'include',
  });
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', 'Template download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = format === 'csv' ? 'classrooms-template.csv' : 'classrooms-template.xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ClassroomImportModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setFile(null);
    setReport(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  function close() {
    reset();
    onClose();
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    setFile(e.target.files?.[0] ?? null);
    setReport(null);
    setError(null);
  }

  async function run(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      if (dryRun) form.append('dryRun', 'true');
      const result = await api.upload<ImportReport>('/classrooms/import', form);
      setReport(result);
      if (!dryRun && result.valid) {
        toast(`Imported: ${result.summary.created} created, ${result.summary.skipped} unchanged`);
        onImported();
        reset();
        onClose();
      }
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 422 && err.details && typeof err.details === 'object') {
        setReport(err.details as ImportReport);
        setError(err.message);
      } else {
        setError(err instanceof ApiError ? err.message : 'Import failed');
      }
    } finally {
      setBusy(false);
    }
  }

  const errorRows = report?.rows.filter((r) => r.errors.length > 0) ?? [];

  return (
    <Modal
      open={open}
      onClose={close}
      title="Import classrooms"
      description="CSV or Excel with room_number, building, floor, bench_count."
      size="lg"
      footer={
        <>
          <Button onClick={close} disabled={busy}>Close</Button>
          <Button onClick={() => void run(true)} disabled={!file || busy} loading={busy}>Validate (dry run)</Button>
          <Button variant="primary" onClick={() => void run(false)} disabled={!file || busy} loading={busy}>Import</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void downloadClassroomTemplate('csv')}>
            <Download className="h-4 w-4" aria-hidden="true" />
            CSV template
          </Button>
          <Button size="sm" onClick={() => void downloadClassroomTemplate('xlsx')}>
            <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
            Excel template
          </Button>
        </div>

        <div className="rounded-lg border border-dashed border-line bg-surface p-4 text-center">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx"
            aria-label="Classrooms file"
            onChange={onFileChange}
            className="sr-only"
            disabled={busy}
          />
          <div className="flex flex-col items-center gap-2">
            <FileSpreadsheet className="h-8 w-8 text-ink-muted" aria-hidden="true" />
            <p className="text-sm text-ink">
              {file ? file.name : 'Drag or select a CSV or Excel file'}
            </p>
            <Button size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
              <Upload className="h-4 w-4" aria-hidden="true" />
              Choose file
            </Button>
          </div>
        </div>

        {report && (
          <div className="space-y-3 rounded-lg border border-line bg-canvas p-3 text-sm">
            <div className="flex flex-wrap items-center gap-3 text-ink-muted">
              <span>Total: {report.summary.total}</span>
              <span>Created: {report.summary.created}</span>
              <span>Skipped: {report.summary.skipped}</span>
              <span>Errors: {report.summary.errors}</span>
              <span>Status: {report.valid ? 'Valid' : 'Invalid'}</span>
              {report.dryRun && <span className="font-medium text-ink">Dry run</span>}
            </div>
            {error && <p className="text-red-600">{error}</p>}
            {errorRows.length > 0 && (
              <div className="max-h-48 overflow-auto rounded border border-line">
                <table className="min-w-full divide-y divide-line">
                  <thead className="bg-surface text-left text-xs uppercase tracking-wide text-ink-muted">
                    <tr>
                      <th className="px-2 py-1">Row</th>
                      <th className="px-2 py-1">Room</th>
                      <th className="px-2 py-1">Errors</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {errorRows.map((r) => (
                      <tr key={`${r.row}-${r.roomNumber ?? ''}`}>
                        <td className="px-2 py-1">{r.row}</td>
                        <td className="px-2 py-1">{r.roomNumber ?? '—'}</td>
                        <td className="px-2 py-1 text-red-600">{r.errors.join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}