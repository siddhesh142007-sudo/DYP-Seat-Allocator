import { useRef, useState, type ChangeEvent } from 'react';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { api, ApiError, API_BASE } from '../../api/client';
import { getSession } from '../../api/authStore';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/toastContext';

interface ImportRowReport {
  row: number;
  rollNumber: string;
  name: string;
  action: 'create' | 'update' | 'skip' | 'error';
  errors: string[];
}

interface ImportReport {
  dryRun: boolean;
  valid: boolean;
  summary: { total: number; created: number; updated: number; skipped: number; errors: number };
  rows: ImportRowReport[];
}

async function downloadTemplate(format: 'csv' | 'xlsx') {
  const headers: Record<string, string> = {};
  const token = getSession().accessToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/v1/students/import/template?format=${format}`, {
    headers,
    credentials: 'include',
  });
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', 'Template download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = format === 'csv' ? 'students-template.csv' : 'students-template.xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function StudentImportModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
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
      const result = await api.upload<ImportReport>('/students/import', form);
      setReport(result);
      if (!dryRun && result.valid) {
        toast(`Imported: ${result.summary.created} created, ${result.summary.updated} updated, ${result.summary.skipped} unchanged`);
        onImported();
        reset();
        onClose();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.details && typeof err.details === 'object') {
        // Row-error report travels in the error envelope; show it inline.
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
      title="Import students"
      description="CSV or Excel with roll number, name, department and academic year."
      size="lg"
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Close
          </Button>
          <Button onClick={() => void run(true)} disabled={!file || busy} loading={busy}>
            Validate (dry run)
          </Button>
          <Button variant="primary" onClick={() => void run(false)} disabled={!file || busy} loading={busy}>
            Import
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void downloadTemplate('csv')}>
            <Download className="h-4 w-4" aria-hidden="true" />
            CSV template
          </Button>
          <Button size="sm" onClick={() => void downloadTemplate('xlsx')}>
            <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
            Excel template
          </Button>
        </div>

        <div className="rounded-lg border border-dashed border-line bg-surface p-4 text-center">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx"
            aria-label="Students file"
            onChange={onFileChange}
            className="block w-full text-sm text-ink file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100"
          />
          <p className="mt-2 text-xs text-ink-muted">Up to 2000 rows, 5 MB. Import is all-or-nothing.</p>
        </div>

        {error && (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {report && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3 text-sm">
              <span className="rounded-md bg-surface px-2 py-1">
                Rows: <strong>{report.summary.total}</strong>
              </span>
              {!report.dryRun && report.valid && (
                <>
                  <span className="rounded-md bg-emerald-50 px-2 py-1 text-emerald-700">
                    Created: <strong>{report.summary.created}</strong>
                  </span>
                  <span className="rounded-md bg-brand-50 px-2 py-1 text-brand-700">
                    Updated: <strong>{report.summary.updated}</strong>
                  </span>
                  <span className="rounded-md bg-slate-100 px-2 py-1 text-slate-600">
                    Skipped: <strong>{report.summary.skipped}</strong>
                  </span>
                </>
              )}
              {report.summary.errors > 0 && (
                <span className="rounded-md bg-red-50 px-2 py-1 text-red-700">
                  Errors: <strong>{report.summary.errors}</strong>
                </span>
              )}
            </div>

            {errorRows.length > 0 && (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-red-200">
                <table className="w-full text-xs">
                  <thead className="bg-red-50 text-left text-red-700">
                    <tr>
                      <th className="px-3 py-2">Row</th>
                      <th className="px-3 py-2">Roll</th>
                      <th className="px-3 py-2">Problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errorRows.map((r) => (
                      <tr key={r.row} className="border-t border-red-100">
                        <td className="px-3 py-1.5">{r.row}</td>
                        <td className="px-3 py-1.5">{r.rollNumber || '—'}</td>
                        <td className="px-3 py-1.5 text-red-700">{r.errors.join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {report.dryRun && report.valid && (
              <p className="text-sm text-emerald-700">
                <Upload className="mr-1 inline h-4 w-4" aria-hidden="true" />
                All {report.summary.total} rows look valid. Press Import to apply.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
