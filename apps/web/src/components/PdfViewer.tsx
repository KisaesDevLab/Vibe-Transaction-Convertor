import { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { withBase } from '../lib/api';
import { pdfBboxToCss } from '../lib/coords';

// Vendor the worker locally (no CDN) — Vite resolves via ?url import.
// The worker.min.mjs file is shipped alongside pdfjs-dist.
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export interface PdfHighlight {
  // 1-based page to show.
  page: number;
  // PDF user-space [x1, y1, x2, y2] to outline; null when the extractor didn't
  // report a box — the viewer still navigates to `page`, it just draws nothing.
  bbox: [number, number, number, number] | null;
  // Optional identity of the highlighted item (e.g. the selected transaction
  // id). Navigation is keyed on (id, page), so an equal highlight re-created
  // on a re-render never snaps the viewer back, while picking another row on
  // the same page does return to it.
  id?: string | undefined;
}

export interface PdfViewerProps {
  pdfHash: string;
  highlight: PdfHighlight | null;
  onPdfClick?: (loc: { page: number; x: number; y: number }) => void;
  // When provided, renders a destructive "Delete PDF" button in the
  // viewer header. Parent is responsible for the confirm dialog and
  // for hiding the viewer entirely once the PDF is actually gone.
  onDeletePdf?: () => void;
  // Disables the Delete-PDF button while the parent's mutation is
  // pending. Has no effect when onDeletePdf is not supplied.
  deletePdfBusy?: boolean;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const STORAGE_KEY = 'vibetc:pdfviewer:zoom';
const FIT_KEY = 'vibetc:pdfviewer:fit';

type FitMode = 'manual' | 'width' | 'page';

// Zoom for Fit width / Fit page from the available CSS box and the page's
// UNSCALED PDF size (it must not depend on the current zoom, or the fit
// feeds back into itself). Null when there's nothing to fit yet (page size
// unknown, or the viewer is hidden and has no width). Clamped to 25%–400%.
export const computeFitZoom = (
  fit: 'width' | 'page',
  availW: number,
  availH: number,
  pdfW: number,
  pdfH: number,
): number | null => {
  if (pdfW <= 0 || pdfH <= 0 || availW <= 0) return null;
  const widthScale = availW / pdfW;
  const z =
    fit === 'width' ? widthScale : Math.min(widthScale, availH > 0 ? availH / pdfH : widthScale);
  return Math.max(0.25, Math.min(4, z));
};

// Keep a 1-based page inside the document. A highlight's page is the
// extractor's sourcePage, which has no upper bound, so it can point past the
// end. Until the page count is known (0) the page passes through; the viewer
// re-clamps once the document loads.
export const clampPage = (page: number, numPages: number): number =>
  numPages > 0 ? Math.min(Math.max(1, page), numPages) : page;

export function PdfViewer({
  pdfHash,
  highlight,
  onPdfClick,
  onDeletePdf,
  deletePdfBusy,
}: PdfViewerProps) {
  // We feed pdf.js the raw bytes (Uint8Array) instead of a blob: URL.
  // Wrapping the API response in URL.createObjectURL and handing that
  // string to <Document file={...}/> makes pdf.js's worker do its own
  // XHR against the blob URL, which can resolve to status 0 in pdf.js
  // v4 even though the document is fully readable. Bytes-in-memory
  // bypass that entirely.
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The source PDF was intentionally purged (admin Delete-PDF or the retention
  // sweep): the API answers /raw with 410. This is distinct from a transient
  // load error — a Retry can't bring the bytes back — so it gets its own
  // graceful state instead of surfacing as "Could not load PDF: HTTP 410". The
  // parent normally swaps the whole viewer for its own deleted-state notice via
  // `sourcePdfDeleted`; this covers the window where that flag is stale (e.g.
  // the PDF was swept server-side, or a sibling statement sharing the hash was
  // deleted) and the viewer is still mounted.
  const [deleted, setDeleted] = useState<boolean>(false);
  // Bumped by Retry to re-run the fetch effect for the same hash.
  const [reloadKey, setReloadKey] = useState<number>(0);
  const [numPages, setNumPages] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [fit, setFit] = useState<FitMode>(() => {
    const v = localStorage.getItem(FIT_KEY);
    return v === 'width' || v === 'page' ? v : 'manual';
  });
  const [zoom, setZoom] = useState<number>(() => {
    const saved = Number.parseFloat(localStorage.getItem(STORAGE_KEY) ?? '');
    return Number.isFinite(saved) && saved > 0 ? saved : 1;
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [pageGeom, setPageGeom] = useState<{
    cssWidth: number;
    cssHeight: number;
    pdfWidth: number;
    pdfHeight: number;
  } | null>(null);

  // Fetch the PDF (cookie-authed) once per hash — and again on Retry — into
  // memory as bytes.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDeleted(false);
    setPdfData(null);
    setNumPages(0);
    if (!pdfHash) return;
    fetch(withBase(`/api/uploads/${pdfHash}/raw`), { credentials: 'include' })
      .then(async (res) => {
        // 410 Gone — the source PDF was deleted. Surface a graceful notice, not
        // a retryable error (the bytes are gone for good).
        if (res.status === 410) {
          if (!cancelled) setDeleted(true);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        if (cancelled) return;
        setPdfData(new Uint8Array(buffer));
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfHash, reloadKey]);

  // Jump to the highlighted page when the highlight changes. Keyed on
  // primitives, not the object, so a parent re-render that rebuilds an equal
  // highlight doesn't snap the viewer back after the operator paged away.
  // Clamped to the page count, which only changes when a document loads.
  const highlightPage = highlight?.page ?? 0;
  const highlightId = highlight?.id;
  useEffect(() => {
    if (highlightPage > 0) setPage(clampPage(highlightPage, numPages));
  }, [highlightPage, highlightId, numPages]);

  // Persist zoom + fit mode.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(zoom));
  }, [zoom]);
  useEffect(() => {
    localStorage.setItem(FIT_KEY, fit);
  }, [fit]);

  // Recompute zoom when fit mode is fit-width / fit-page based on the
  // available container width and the natural (unscaled) PDF page size.
  const pdfW = pageGeom?.pdfWidth ?? 0;
  const pdfH = pageGeom?.pdfHeight ?? 0;
  useEffect(() => {
    if (fit === 'manual') return;
    const recompute = (): void => {
      const c = containerRef.current;
      if (!c) return;
      // The container's height follows the page we render, so measuring it
      // for Fit page would feed the current zoom back into itself. Bound the
      // page area by the window instead: viewport height minus the toolbar,
      // the page area's padding (24) and the borders (2).
      const toolbarH = (c.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
      const z = computeFitZoom(
        fit,
        c.clientWidth - 24,
        window.innerHeight - toolbarH - 26,
        pdfW,
        pdfH,
      );
      if (z !== null) setZoom(z);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [fit, pdfW, pdfH]);

  // Keyboard shortcuts: arrow keys page nav, +/- zoom.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Bare keys only: Ctrl/Cmd with +/- is the browser's own zoom and
      // Alt+Arrow is history navigation.
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (target?.isContentEditable) return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        setPage((p) => Math.max(1, p - 1));
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        setPage((p) => Math.min(numPages, p + 1));
      } else if (e.key === '+' || e.key === '=') {
        setFit('manual');
        setZoom((z) => {
          const idx = ZOOM_STEPS.findIndex((s) => s >= z);
          return ZOOM_STEPS[Math.min(idx + 1, ZOOM_STEPS.length - 1)] ?? z;
        });
      } else if (e.key === '-') {
        setFit('manual');
        setZoom((z) => {
          const idx = ZOOM_STEPS.findIndex((s) => s >= z);
          return ZOOM_STEPS[Math.max(idx - 1, 0)] ?? z;
        });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [numPages]);

  // Outline only when the highlight carries a bbox (page-only highlights just
  // navigate).
  const overlay = useMemo(() => {
    if (!highlight?.bbox || !pageGeom || highlight.page !== page) return null;
    return pdfBboxToCss(highlight.bbox, pageGeom);
  }, [highlight, pageGeom, page]);

  // pdf.js's worker transfers (not copies) the ArrayBuffer we hand it,
  // detaching our cached pdfData after the first load. Memoize the
  // file prop so react-pdf never re-issues the load on subsequent
  // renders, and pass a fresh copy of the bytes to pdf.js so our
  // pdfData stays usable for the Download button.
  const fileForViewer = useMemo(() => (pdfData ? { data: pdfData.slice() } : null), [pdfData]);

  const onPageLoad = (pdfPage: { originalWidth: number; originalHeight: number }) => {
    // Use the unscaled PDF user-space size. react-pdf's page.width/height are
    // already multiplied by the current `scale` and this callback re-fires on
    // every scale change, so feeding them to the fit math made Fit width/page
    // oscillate forever and skewed the bbox/click mapping by the zoom factor.
    requestAnimationFrame(() => {
      const el = pageRef.current?.querySelector('.react-pdf__Page__canvas');
      if (!el) return;
      const rect = (el as HTMLElement).getBoundingClientRect();
      setPageGeom({
        cssWidth: rect.width,
        cssHeight: rect.height,
        pdfWidth: pdfPage.originalWidth,
        pdfHeight: pdfPage.originalHeight,
      });
    });
  };

  const onPageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onPdfClick || !pageGeom) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const sx = pageGeom.pdfWidth / pageGeom.cssWidth;
    const sy = pageGeom.pdfHeight / pageGeom.cssHeight;
    const x = cssX * sx;
    const y = pageGeom.pdfHeight - cssY * sy;
    onPdfClick({ page, x, y });
  };

  return (
    <div
      ref={containerRef}
      className="rounded-lg border border-surface-muted bg-white print:hidden"
    >
      <div className="flex items-center justify-between border-b border-surface-muted bg-surface-subtle px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded border border-surface-muted px-2 py-0.5 disabled:opacity-50"
          >
            ←
          </button>
          <span>
            Page {page} / {numPages || '—'}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(numPages, p + 1))}
            disabled={page >= numPages}
            className="rounded border border-surface-muted px-2 py-0.5 disabled:opacity-50"
          >
            →
          </button>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={fit}
            onChange={(e) => setFit(e.target.value as FitMode)}
            className="rounded border border-surface-muted bg-white px-1 py-0.5"
            title="Fit mode"
          >
            <option value="manual">Manual</option>
            <option value="width">Fit width</option>
            <option value="page">Fit page</option>
          </select>
          <select
            value={ZOOM_STEPS.includes(zoom) ? zoom : ''}
            onChange={(e) => {
              setFit('manual');
              setZoom(Number.parseFloat(e.target.value));
            }}
            disabled={fit !== 'manual'}
            className="rounded border border-surface-muted bg-white px-1 py-0.5 disabled:opacity-50"
          >
            {!ZOOM_STEPS.includes(zoom) ? (
              <option value="">{Math.round(zoom * 100)}%</option>
            ) : null}
            {ZOOM_STEPS.map((s) => (
              <option key={s} value={s}>
                {Math.round(s * 100)}%
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              // Construct a transient blob URL just for this click.
              // No revoke needed — modern browsers GC blob URLs after
              // the click, and we only build one per click.
              if (!pdfData) return;
              // Cast through ArrayBuffer to satisfy TS — pdfData is a
              // Uint8Array whose .buffer can technically be a
              // SharedArrayBuffer, which the Blob ctor types reject.
              const blob = new Blob([pdfData.slice().buffer], { type: 'application/pdf' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${pdfHash.slice(0, 12)}.pdf`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 0);
            }}
            disabled={!pdfData}
            className="rounded border border-surface-muted px-2 py-0.5 disabled:opacity-50"
          >
            ↓ Download
          </button>
          {onDeletePdf ? (
            <button
              type="button"
              onClick={onDeletePdf}
              disabled={deletePdfBusy}
              title="Remove the source PDF from disk. The statement and transactions are kept."
              className="rounded border border-danger px-2 py-0.5 text-danger hover:bg-danger/5 disabled:opacity-50"
            >
              {deletePdfBusy ? 'Deleting…' : 'Delete PDF'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="relative overflow-auto bg-surface-subtle p-3">
        {deleted ? (
          <div className="grid h-64 place-items-center px-6 text-center text-sm text-ink-muted">
            <div>
              <p className="font-medium text-ink">Source PDF has been deleted.</p>
              <p className="mt-1">
                The extracted transactions and export files are still available. The original PDF
                was removed from disk by an admin action or the retention sweep.
              </p>
            </div>
          </div>
        ) : error ? (
          <div className="grid h-64 place-items-center text-sm text-danger">
            Could not load PDF: {error}
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-2 rounded border border-surface-muted bg-white px-3 py-1 text-xs"
            >
              Retry
            </button>
          </div>
        ) : !pdfData ? (
          <div className="grid h-64 animate-pulse place-items-center rounded-md bg-surface-muted/50 text-xs text-ink-muted">
            Loading PDF…
          </div>
        ) : (
          <Document
            file={fileForViewer}
            onLoadSuccess={({ numPages: n }) => {
              setNumPages(n);
              // Re-clamp a page picked before the page count was known (a
              // highlight past the end, or a page from another document).
              setPage((p) => clampPage(p, n));
            }}
            onLoadError={(err) => setError(err.message)}
            loading={null}
          >
            <div ref={pageRef} className="relative inline-block" onClick={onPageClick}>
              {/* Document renders its children before onLoadSuccess runs, so
                  wait for the page count: an unclamped page past the end would
                  fail to load ("Failed to load the page"). */}
              {numPages > 0 ? (
                <Page
                  pageNumber={page}
                  scale={zoom}
                  onLoadSuccess={onPageLoad}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                />
              ) : null}
              {overlay ? (
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: overlay.left,
                    top: overlay.top,
                    width: overlay.width,
                    height: overlay.height,
                    background: 'rgba(250, 204, 21, 0.30)',
                    border: '2px solid rgba(202, 138, 4, 0.9)',
                    pointerEvents: 'none',
                  }}
                />
              ) : null}
            </div>
          </Document>
        )}
      </div>
    </div>
  );
}
