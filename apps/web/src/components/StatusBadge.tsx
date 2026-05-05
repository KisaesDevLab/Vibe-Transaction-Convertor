import { cn } from '../lib/cn';

const STATUS_PALETTE: Record<string, { label: string; color: string; pulse?: boolean }> = {
  uploaded: { label: 'uploaded', color: 'bg-surface-muted text-ink' },
  preprocessing: { label: 'preprocessing', color: 'bg-blue-50 text-blue-700' },
  ocr: { label: 'OCR', color: 'bg-blue-50 text-blue-700' },
  extracting: { label: 'extracting', color: 'bg-blue-50 text-blue-700' },
  reconciling: { label: 'reconciling', color: 'bg-blue-50 text-blue-700' },
  'awaiting-locale-confirmation': {
    label: 'awaiting date format',
    color: 'bg-amber-100 text-amber-900 ring-1 ring-amber-300',
    pulse: true,
  },
  review: { label: 'review', color: 'bg-yellow-50 text-yellow-800' },
  exported: { label: 'exported', color: 'bg-emerald-50 text-emerald-800' },
  failed: { label: 'failed', color: 'bg-red-50 text-red-800' },
};

const RECON_PALETTE: Record<string, { label: string; color: string }> = {
  pending: { label: 'pending', color: 'bg-surface-muted text-ink-muted' },
  verified: { label: 'verified', color: 'bg-emerald-50 text-emerald-800' },
  discrepancy: { label: 'discrepancy', color: 'bg-red-50 text-red-800' },
  overridden: { label: 'overridden', color: 'bg-amber-50 text-amber-900' },
  failed: { label: 'failed', color: 'bg-red-50 text-red-800' },
};

const IN_FLIGHT = new Set(['preprocessing', 'ocr', 'extracting', 'reconciling']);

export function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_PALETTE[status] ?? { label: status, color: 'bg-surface-muted text-ink' };
  const inFlight = IN_FLIGHT.has(status);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium',
        cfg.color,
        cfg.pulse ? 'animate-pulse' : '',
      )}
    >
      {inFlight ? <Spinner /> : null}
      {cfg.label}
    </span>
  );
}

export function ReconciliationBadge({
  status,
  periodBoundsViolations,
}: {
  status: string;
  periodBoundsViolations?: number;
}) {
  const cfg = RECON_PALETTE[status] ?? { label: status, color: 'bg-surface-muted text-ink' };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium',
        cfg.color,
      )}
    >
      {cfg.label}
      {status === 'discrepancy' && periodBoundsViolations && periodBoundsViolations > 0 ? (
        <span className="text-[10px] opacity-80">· {periodBoundsViolations} outside period</span>
      ) : null}
    </span>
  );
}

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M12 2 a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
