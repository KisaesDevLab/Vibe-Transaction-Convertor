import { describe, expect, it } from 'vitest';

import { computeSteps, isInFlight } from './ProcessingStepper';

describe('isInFlight', () => {
  it('is true only for the active processing statuses', () => {
    for (const s of ['preprocessing', 'ocr', 'extracting', 'reconciling']) {
      expect(isInFlight(s)).toBe(true);
    }
    for (const s of ['uploaded', 'awaiting-locale-confirmation', 'review', 'exported', 'failed']) {
      expect(isInFlight(s)).toBe(false);
    }
  });
});

describe('computeSteps', () => {
  const stateOf = (status: string, key: string, method?: string | null) =>
    computeSteps(status, method).find((s) => s.key === key)?.state;

  it('marks the current status active, earlier steps done, later steps pending', () => {
    const steps = computeSteps('extracting', 'ocr');
    expect(steps.map((s) => s.state)).toEqual([
      'done', // upload
      'done', // preprocess
      'done', // ocr
      'active', // extract
      'pending', // reconcile
      'pending', // review
    ]);
  });

  it('advances the active node as status progresses', () => {
    expect(stateOf('preprocessing', 'preprocess')).toBe('active');
    expect(stateOf('ocr', 'ocr')).toBe('active');
    expect(stateOf('reconciling', 'reconcile')).toBe('active');
  });

  it('skips the OCR node for text-layer statements (never run, not "done")', () => {
    expect(stateOf('extracting', 'ocr', 'text')).toBe('skipped');
    // OCR statements keep it in the normal done/active flow.
    expect(stateOf('extracting', 'ocr', 'ocr')).toBe('done');
    expect(stateOf('ocr', 'ocr', 'ocr')).toBe('active');
  });

  it('collapses exported onto the review node (pipeline complete)', () => {
    expect(stateOf('exported', 'review')).toBe('active');
  });
});
