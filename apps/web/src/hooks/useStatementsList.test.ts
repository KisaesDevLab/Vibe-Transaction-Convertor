import { describe, expect, it } from 'vitest';

import { exportBlockReason, recomputeToast } from './useStatementsList';

const ok = {
  status: 'review',
  reconciliationStatus: 'verified',
  reviewHoldReason: null,
  reviewHoldAcknowledged: false,
};

describe('exportBlockReason', () => {
  it('allows verified or overridden statements in review/exported', () => {
    expect(exportBlockReason(ok)).toBeNull();
    expect(exportBlockReason({ ...ok, status: 'exported' })).toBeNull();
    expect(exportBlockReason({ ...ok, reconciliationStatus: 'overridden' })).toBeNull();
  });

  it('blocks a stale verified reconciliation outside review/exported', () => {
    for (const status of [
      'uploaded',
      'preprocessing',
      'ocr',
      'extracting',
      'reconciling',
      'failed',
      'awaiting-locale-confirmation',
    ]) {
      expect(exportBlockReason({ ...ok, status })).not.toBeNull();
    }
    expect(exportBlockReason({ ...ok, status: 'failed' })).toMatch(/re-extract/);
    expect(exportBlockReason({ ...ok, status: 'awaiting-locale-confirmation' })).toMatch(
      /date format/,
    );
    expect(exportBlockReason({ ...ok, status: 'extracting' })).toMatch(/still processing/);
  });

  it('blocks unreconciled statements', () => {
    expect(exportBlockReason({ ...ok, reconciliationStatus: 'discrepancy' })).toMatch(
      /discrepancy/,
    );
    expect(exportBlockReason({ ...ok, reconciliationStatus: 'pending' })).toMatch(/not verified/);
    expect(exportBlockReason({ ...ok, reconciliationStatus: 'failed' })).toMatch(/not verified/);
  });

  it('blocks an unacknowledged review hold until acknowledged', () => {
    const held = { ...ok, reviewHoldReason: '3 low-confidence rows' };
    expect(exportBlockReason(held)).toMatch(/review hold/i);
    expect(exportBlockReason({ ...held, reviewHoldAcknowledged: true })).toBeNull();
  });
});

describe('recomputeToast', () => {
  it('reports a fresh verdict as a success', () => {
    expect(recomputeToast({ status: 'discrepancy', deltaCents: '-500' })).toEqual({
      kind: 'success',
      message: 'Reconciliation: discrepancy (Δ -500¢)',
    });
    expect(recomputeToast({ status: 'verified', deltaCents: '0', recomputed: true }).kind).toBe(
      'success',
    );
  });

  it('says why nothing was recomputed instead of echoing the unchanged status', () => {
    expect(recomputeToast({ status: 'overridden', deltaCents: '-500', recomputed: false })).toEqual(
      { kind: 'info', message: 'Override is sticky — not recomputed' },
    );
    expect(recomputeToast({ status: 'pending', deltaCents: '0', recomputed: false })).toEqual({
      kind: 'info',
      message: 'No balances extracted yet — nothing to recompute',
    });
  });
});
