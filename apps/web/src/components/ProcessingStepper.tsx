import { cn } from '../lib/cn';

// Live "where in the pipeline is this statement" indicator. Driven by the
// statement's `status` (polled every 3s by the list/detail queries) plus the
// method/provider/model the worker persists the moment extraction starts. Shown
// only while a statement is in-flight; terminal statuses keep the plain badge.

type StepKey = 'upload' | 'preprocess' | 'ocr' | 'extract' | 'reconcile' | 'review';

const STEPS: ReadonlyArray<{ key: StepKey; label: string }> = [
  { key: 'upload', label: 'Upload' },
  { key: 'preprocess', label: 'Preprocess' },
  { key: 'ocr', label: 'OCR' },
  { key: 'extract', label: 'Extract' },
  { key: 'reconcile', label: 'Reconcile' },
  { key: 'review', label: 'Review' },
];

// status → index of the active step. `ocr` and `extracting` are distinct phases
// (two-stage scanned extraction OCRs to markdown, then schema-extracts), so they
// map to separate steps. exported collapses onto review (pipeline complete).
const STATUS_TO_INDEX: Record<string, number> = {
  uploaded: 0,
  preprocessing: 1,
  ocr: 2,
  extracting: 3,
  reconciling: 4,
  review: 5,
  exported: 5,
};

const IN_FLIGHT = new Set(['preprocessing', 'ocr', 'extracting', 'reconciling']);

// True while the worker is actively processing the statement — the only time
// the stepper is worth showing. Callers fall back to <StatusBadge> otherwise.
export const isInFlight = (status: string): boolean => IN_FLIGHT.has(status);

export type StepState = 'done' | 'active' | 'pending' | 'skipped';
export interface StepView {
  key: StepKey;
  label: string;
  state: StepState;
}

// Index of the active node for `status`. Unknown statuses (terminal/failed)
// fall back to 0 — the stepper isn't rendered for those anyway.
export const activeStepIndex = (status: string): number => STATUS_TO_INDEX[status] ?? 0;

// Pure status+method → per-step state, extracted so the mapping is unit-testable
// without rendering. A text-layer statement never runs OCR, so that node is
// `skipped` rather than `done`/`pending`.
export const computeSteps = (status: string, method?: string | null): StepView[] => {
  const activeIndex = activeStepIndex(status);
  return STEPS.map((step, i) => {
    if (step.key === 'ocr' && method === 'text') {
      return { ...step, state: 'skipped' };
    }
    const state: StepState = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending';
    return { ...step, state };
  });
};

const methodLabel = (m: string | null | undefined): string | null => {
  if (m === 'text') return 'Text-layer';
  if (m === 'ocr') return 'OCR';
  if (m === 'hybrid') return 'Hybrid (OCR + text)';
  return null;
};

export interface ProcessingStepperProps {
  status: string;
  method?: 'text' | 'ocr' | 'hybrid' | null;
  provider?: 'local' | 'anthropic' | null;
  model?: string | null;
  // Dense single-row variant for list cells. Default is the fuller review-page
  // header layout with labels under each node.
  compact?: boolean;
}

export function ProcessingStepper({
  status,
  method,
  provider,
  model,
  compact = false,
}: ProcessingStepperProps) {
  const activeIndex = activeStepIndex(status);
  const steps = computeSteps(status, method);

  const usingParts = [methodLabel(method), provider, model].filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );
  const using = usingParts.join(' · ');

  const dot = compact ? 'h-2 w-2' : 'h-2.5 w-2.5';
  const conn = compact ? 'w-3' : 'w-6';

  return (
    <div
      className={cn('inline-flex flex-col gap-1', compact ? 'text-[10px]' : 'text-xs')}
      role="group"
      aria-label={`Processing: ${STEPS[activeIndex]?.label ?? status}`}
    >
      <div className="flex items-center">
        {steps.map((step, i) => {
          const state = step.state;
          return (
            <div key={step.key} className="flex items-center">
              {i > 0 ? (
                <span
                  className={cn(
                    'h-px',
                    conn,
                    i <= activeIndex ? 'bg-blue-400' : 'bg-surface-muted',
                  )}
                />
              ) : null}
              <div className="flex flex-col items-center gap-0.5">
                <span className="grid place-items-center" aria-hidden="true">
                  {state === 'active' ? (
                    <Spinner className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
                  ) : (
                    <span
                      className={cn(
                        'rounded-full',
                        dot,
                        state === 'done'
                          ? 'bg-blue-500'
                          : state === 'skipped'
                            ? 'bg-transparent ring-1 ring-dashed ring-surface-muted'
                            : 'bg-surface-muted',
                      )}
                    />
                  )}
                </span>
                {!compact ? (
                  <span
                    className={cn(
                      'leading-none',
                      state === 'active'
                        ? 'font-medium text-blue-700'
                        : state === 'done'
                          ? 'text-ink-muted'
                          : state === 'skipped'
                            ? 'text-ink-subtle line-through'
                            : 'text-ink-subtle',
                    )}
                  >
                    {step.label}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {compact ? (
        <span className="text-blue-700">
          {STEPS[activeIndex]?.label ?? status}
          {using ? <span className="text-ink-subtle"> · {using}</span> : null}
        </span>
      ) : using ? (
        <span className="text-ink-subtle">
          using: <span className="text-ink-muted">{using}</span>
        </span>
      ) : null}
    </div>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('animate-spin text-blue-600', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
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
