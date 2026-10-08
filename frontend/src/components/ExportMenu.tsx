import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { Button } from './ui/Button';
import { useToast } from './ui/toastContext';
import type { ReactNode } from 'react';

type ExportFormat = 'csv' | 'xlsx' | 'pdf';

interface ExportMenuProps {
  examId: string;
  isPublished: boolean;
  disabled?: boolean;
  trigger?: ReactNode;
}

function exportPath(examId: string, kind: 'classroom' | 'department' | 'students' | 'plan', format: ExportFormat) {
  return `/exports/exams/${examId}/${kind}?format=${format}`;
}

function slipPath(examId: string, format: ExportFormat, studentId?: string) {
  if (studentId) return `/exports/exams/${examId}/slip?format=${format}&studentId=${studentId}`;
  return `/exports/exams/${examId}/slip?format=${format}`;
}

function slipsPath(examId: string, format: ExportFormat) {
  return `/exports/exams/${examId}/slips?format=${format}`;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ExportMenu({ examId, isPublished, disabled, trigger }: ExportMenuProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [includeDraft, setIncludeDraft] = useState(false);

  async function doExport(kind: 'classroom' | 'department' | 'students' | 'plan') {
    try {
      setBusy(true);
      const path = exportPath(examId, kind, format);
      const params = includeDraft && !isPublished ? `${path.includes('?') ? '&' : '?'}includeDraft=true` : '';
      const blob = await api.download(path + params);
      const ext = format === 'xlsx' ? 'xlsx' : format === 'csv' ? 'csv' : 'pdf';
      saveBlob(blob, `exam-${examId.slice(0, 8)}-${kind}.${ext}`);
      toast('Export ready');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Export failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function doSlip(studentId?: string) {
    try {
      setBusy(true);
      const blob = await api.download(slipPath(examId, format, studentId));
      const ext = format === 'pdf' ? 'pdf' : 'pdf';
      saveBlob(blob, `exam-${examId.slice(0, 8)}-slip.${ext}`);
      toast('Slip ready');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Export failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function doBulkSlips() {
    try {
      setBusy(true);
      const blob = await api.download(slipsPath(examId, format));
      saveBlob(blob, `exam-${examId.slice(0, 8)}-slips.pdf`);
      toast('Slips ready');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Export failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  const defaultTrigger = (
    <Button variant="ghost" size="sm" disabled={disabled || busy} aria-haspopup="menu">
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
      <span className="ml-1 hidden sm:inline">Export</span>
    </Button>
  );

  return (
    <div className="relative inline-block">
      <span onClick={() => !disabled && setOpen((o) => !o)}>{trigger ?? defaultTrigger}</span>
      {open && (
        <div role="menu" className="absolute right-0 z-10 mt-2 w-64 rounded-md border border-line bg-canvas shadow-lg">
          <div className="p-2 space-y-2">
            <fieldset className="space-y-1">
              <legend className="px-1 text-xs font-medium text-ink-muted uppercase">Format</legend>
              <div className="flex gap-1 px-1">
                {(['pdf', 'csv', 'xlsx'] as ExportFormat[]).map((f) => (
                  <label key={f} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs">
                    <input
                      type="radio"
                      name="fmt"
                      checked={format === f}
                      onChange={() => setFormat(f)}
                    />
                    <span className="uppercase">{f}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {!isPublished && (
              <label className="flex items-center gap-2 px-1 text-xs text-ink-muted">
                <input type="checkbox" checked={includeDraft} onChange={(e) => setIncludeDraft(e.target.checked)} />
                Include draft (watermarked)
              </label>
            )}
            <div className="border-t border-line" />
            <div className="flex flex-col gap-1">
              <Button variant="ghost" size="sm" className="justify-start" onClick={() => doExport('classroom')} disabled={busy}>
                Classroom-wise
              </Button>
              <Button variant="ghost" size="sm" className="justify-start" onClick={() => doExport('department')} disabled={busy}>
                Department-wise
              </Button>
              <Button variant="ghost" size="sm" className="justify-start" onClick={() => doExport('students')} disabled={busy}>
                Student-wise
              </Button>
              <Button variant="ghost" size="sm" className="justify-start" onClick={() => doExport('plan')} disabled={busy}>
                Full plan
              </Button>
              <Button variant="ghost" size="sm" className="justify-start" onClick={() => doSlip()} disabled={busy}>
                Single slip (PDF)
              </Button>
              <Button variant="ghost" size="sm" className="justify-start" onClick={() => doBulkSlips()} disabled={busy}>
                Bulk slips (PDF)
              </Button>
            </div>
          </div>
          <div className="border-t border-line p-2">
            <Button variant="secondary" size="sm" className="w-full" onClick={() => setOpen(false)} disabled={busy}>
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}