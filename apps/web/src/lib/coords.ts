// PDF coordinate conversion. PDF user-space origin is bottom-left;
// rendered viewport origin is top-left. The bbox stored on
// transactions.source_bbox_json is in PDF user-space [x1, y1, x2, y2].
// The viewer needs CSS pixel offsets relative to the rendered page.

export interface RenderedPage {
  // Width/height of the page as rendered to the DOM (CSS pixels).
  cssWidth: number;
  cssHeight: number;
  // Width/height of the page in PDF user units (default 72 dpi).
  pdfWidth: number;
  pdfHeight: number;
}

export interface BboxOverlay {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const pdfBboxToCss = (
  bbox: [number, number, number, number],
  page: RenderedPage,
): BboxOverlay => {
  const [x1, y1, x2, y2] = bbox;
  const sx = page.cssWidth / page.pdfWidth;
  const sy = page.cssHeight / page.pdfHeight;
  // Flip y because PDF origin is bottom-left.
  const top = page.cssHeight - y2 * sy;
  const left = x1 * sx;
  const width = (x2 - x1) * sx;
  const height = (y2 - y1) * sy;
  return { left, top, width, height };
};
