import { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

import { pdfBboxToCss } from '../lib/coords';

// Vendor the worker locally (no CDN) — Vite resolves via ?url import.
// The worker.min.mjs file is shipped alongside pdfjs-dist.
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export interface PdfViewerProps {
  pdfHash: string;
  highlight: { page: number; bbox: [number, number, number, number] } | null;
  onPdfClick?: (loc: { page: number; x: number; y: number }) => void;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const STORAGE_KEY = 'vibetc:pdfviewer:zoom';

export function PdfViewer({ pdfHash, highlight, onPdfClick }: PdfViewerProps) {
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
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

  // Fetch the PDF (cookie-authed) once per hash.
  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setError(null);
    setPdfBlobUrl(null);
    setNumPages(0);
    if (!pdfHash) return;
    fetch(`/api/uploads/${pdfHash}/raw`, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setPdfBlobUrl(createdUrl);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [pdfHash]);

  // Sync to highlight changes.
  useEffect(() => {
    if (highlight && highlight.page > 0) {
      setPage(highlight.page);
    }
  }, [highlight]);

  // Persist zoom.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(zoom));
  }, [zoom]);

  // Keyboard shortcuts: arrow keys page nav, +/- zoom.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        setPage((p) => Math.max(1, p - 1));
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        setPage((p) => Math.min(numPages, p + 1));
      } else if (e.key === '+' || e.key === '=') {
        setZoom((z) => {
          const idx = ZOOM_STEPS.findIndex((s) => s >= z);
          return ZOOM_STEPS[Math.min(idx + 1, ZOOM_STEPS.length - 1)] ?? z;
        });
      } else if (e.key === '-') {
        setZoom((z) => {
          const idx = ZOOM_STEPS.findIndex((s) => s >= z);
          return ZOOM_STEPS[Math.max(idx - 1, 0)] ?? z;
        });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [numPages]);

  const overlay = useMemo(() => {
    if (!highlight || !pageGeom || highlight.page !== page) return null;
    return pdfBboxToCss(highlight.bbox, pageGeom);
  }, [highlight, pageGeom, page]);

  const onPageLoad = (pdfPage: { width: number; height: number }) => {
    // react-pdf reports pdf user-space dimensions on the PageProxy.
    requestAnimationFrame(() => {
      const el = pageRef.current?.querySelector('.react-pdf__Page__canvas');
      if (!el) return;
      const rect = (el as HTMLElement).getBoundingClientRect();
      setPageGeom({
        cssWidth: rect.width,
        cssHeight: rect.height,
        pdfWidth: pdfPage.width,
        pdfHeight: pdfPage.height,
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
            value={zoom}
            onChange={(e) => setZoom(Number.parseFloat(e.target.value))}
            className="rounded border border-surface-muted bg-white px-1 py-0.5"
          >
            {ZOOM_STEPS.map((s) => (
              <option key={s} value={s}>
                {Math.round(s * 100)}%
              </option>
            ))}
          </select>
          <a
            href={pdfBlobUrl ?? '#'}
            download
            className="rounded border border-surface-muted px-2 py-0.5"
          >
            ↓ Download
          </a>
        </div>
      </div>

      <div className="relative overflow-auto bg-surface-subtle p-3">
        {error ? (
          <div className="grid h-64 place-items-center text-sm text-danger">
            Could not load PDF: {error}
            <button
              type="button"
              onClick={() => setError(null)}
              className="mt-2 rounded border border-surface-muted bg-white px-3 py-1 text-xs"
            >
              Retry
            </button>
          </div>
        ) : !pdfBlobUrl ? (
          <div className="grid h-64 animate-pulse place-items-center rounded-md bg-surface-muted/50 text-xs text-ink-muted">
            Loading PDF…
          </div>
        ) : (
          <Document
            file={pdfBlobUrl}
            onLoadSuccess={({ numPages: n }) => setNumPages(n)}
            onLoadError={(err) => setError(err.message)}
            loading={null}
          >
            <div ref={pageRef} className="relative inline-block" onClick={onPageClick}>
              <Page
                pageNumber={page}
                scale={zoom}
                onLoadSuccess={onPageLoad}
                renderTextLayer={false}
                renderAnnotationLayer={false}
              />
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
