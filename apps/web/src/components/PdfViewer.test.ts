import { describe, expect, it } from 'vitest';

import { clampPage, computeFitZoom } from './PdfViewer';

// US Letter in PDF user units.
const W = 612;
const H = 792;

describe('computeFitZoom', () => {
  it('fits the width from the unscaled page size (stable — no zoom feedback)', () => {
    expect(computeFitZoom('width', 918, 400, W, H)).toBe(1.5);
    // Same inputs, same answer: the result never depends on the current zoom.
    expect(computeFitZoom('width', 918, 400, W, H)).toBe(computeFitZoom('width', 918, 400, W, H));
  });

  it('fits the whole page within the available height', () => {
    expect(computeFitZoom('page', 918, 396, W, H)).toBe(0.5);
    // Height is roomier than width → width wins.
    expect(computeFitZoom('page', 306, 2000, W, H)).toBe(0.5);
    // No usable height → fall back to width.
    expect(computeFitZoom('page', 612, 0, W, H)).toBe(1);
  });

  it('clamps to 25%–400%', () => {
    expect(computeFitZoom('width', 10, 0, W, H)).toBe(0.25);
    expect(computeFitZoom('width', 100_000, 0, W, H)).toBe(4);
  });

  it('returns null when there is nothing to fit (page unknown or viewer hidden)', () => {
    expect(computeFitZoom('width', 900, 900, 0, 0)).toBeNull();
    expect(computeFitZoom('width', -24, 900, W, H)).toBeNull();
  });
});

describe('clampPage', () => {
  it('clamps a page past the end (an unbounded sourcePage) to the last page', () => {
    expect(clampPage(7, 5)).toBe(5);
    expect(clampPage(5, 5)).toBe(5);
    expect(clampPage(3, 5)).toBe(3);
  });

  it('never goes below page 1 once the page count is known', () => {
    expect(clampPage(0, 5)).toBe(1);
  });

  it('passes the page through until the page count is known', () => {
    expect(clampPage(7, 0)).toBe(7);
  });
});
