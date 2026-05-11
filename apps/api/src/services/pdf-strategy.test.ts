import { describe, expect, it } from 'vitest';

import { isPdfProcessingStrategy, type PdfProcessingStrategy } from './pdf-strategy.js';

describe('isPdfProcessingStrategy', () => {
  it('accepts the four valid values', () => {
    for (const v of ['auto', 'force-text', 'force-ocr', 'auto-ocr-fallback'] as const) {
      expect(isPdfProcessingStrategy(v)).toBe(true);
    }
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isPdfProcessingStrategy('hybrid')).toBe(false);
    expect(isPdfProcessingStrategy('AUTO')).toBe(false); // case-sensitive
    expect(isPdfProcessingStrategy('')).toBe(false);
    expect(isPdfProcessingStrategy(undefined)).toBe(false);
    expect(isPdfProcessingStrategy(null)).toBe(false);
    expect(isPdfProcessingStrategy(0)).toBe(false);
    expect(isPdfProcessingStrategy({})).toBe(false);
  });

  it('narrows the type for downstream use', () => {
    const v: unknown = 'force-ocr';
    if (isPdfProcessingStrategy(v)) {
      const narrowed: PdfProcessingStrategy = v;
      expect(narrowed).toBe('force-ocr');
    } else {
      expect.fail('expected narrowing to succeed');
    }
  });
});
