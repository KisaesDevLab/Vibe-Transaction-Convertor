import { describe, expect, it } from 'vitest';
import { schemas } from '@vibe-tx-converter/shared';

import { EXEMPLARS, exemplarsAsMessages } from './exemplars.js';

describe('exemplars', () => {
  it('all exemplars round-trip through the ExtractionResult schema', () => {
    expect(EXEMPLARS.length).toBeGreaterThanOrEqual(4);
    for (const ex of EXEMPLARS) {
      // If parse() throws, test reports the failing exemplar's label.
      expect(() => schemas.extraction.ExtractionResult.parse(ex.expected), ex.label).not.toThrow();
    }
  });

  it('exemplar labels are unique', () => {
    const labels = EXEMPLARS.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('every exemplar has at least one transaction', () => {
    for (const ex of EXEMPLARS) {
      expect(ex.expected.transactions.length, ex.label).toBeGreaterThan(0);
    }
  });

  it('exemplar opening + sum(amounts) === closing (Golden Rule self-check)', () => {
    for (const ex of EXEMPLARS) {
      const sum = ex.expected.transactions.reduce((acc, t) => acc + BigInt(t.amount_cents), 0n);
      const expected = BigInt(ex.expected.balances.opening_cents) + sum;
      expect(expected, `${ex.label} balance reconciliation`).toBe(
        BigInt(ex.expected.balances.closing_cents),
      );
    }
  });

  it('exemplarsAsMessages emits paired user/assistant messages', () => {
    const msgs = exemplarsAsMessages();
    expect(msgs.length).toBe(EXEMPLARS.length * 2);
    for (let i = 0; i < msgs.length; i += 2) {
      expect(msgs[i]?.role).toBe('user');
      expect(msgs[i + 1]?.role).toBe('assistant');
    }
  });
});
