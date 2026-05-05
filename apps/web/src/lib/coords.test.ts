import { describe, expect, it } from 'vitest';
import { pdfBboxToCss } from './coords';

describe('pdfBboxToCss', () => {
  // PDF user space: 612 x 792 (US Letter at 72 dpi); origin bottom-left.
  // Viewport rendered at 100% scale on the same dimensions.
  const samePage = { cssWidth: 612, cssHeight: 792, pdfWidth: 612, pdfHeight: 792 };

  it('returns identity (with y-flip) when scale matches', () => {
    // Bbox at PDF coords (50, 700, 200, 720) — top of the page.
    const css = pdfBboxToCss([50, 700, 200, 720], samePage);
    expect(css.left).toBe(50);
    // top = 792 - 720 = 72 (PDF y2 flipped to CSS top)
    expect(css.top).toBe(72);
    expect(css.width).toBe(150);
    expect(css.height).toBe(20);
  });

  it('scales to the rendered CSS size', () => {
    const renderedAtHalfScale = {
      cssWidth: 306,
      cssHeight: 396,
      pdfWidth: 612,
      pdfHeight: 792,
    };
    const css = pdfBboxToCss([0, 0, 612, 792], renderedAtHalfScale);
    expect(css.left).toBe(0);
    expect(css.top).toBe(0);
    expect(css.width).toBe(306);
    expect(css.height).toBe(396);
  });
});
