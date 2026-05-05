import { Router } from 'express';
import { eq, desc } from 'drizzle-orm';
import JSZip from 'jszip';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { db } from '../db/client.js';
import { exportJobs, statements } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import {
  recordExportJob,
  renderExport,
  renderExportSlices,
  type ExportFormat,
} from '../services/exports.js';
import { writeAudit } from '../services/audit.js';

const VALID: ExportFormat[] = [
  'csv-qbo3',
  'csv-qbo4',
  'csv-xero',
  'csv-generic',
  'ofx',
  'qbo',
  'qfx',
];

export const exportsRouter = (): Router => {
  const router = Router();

  router.post('/:statementId/exports/:format', async (req, res, next) => {
    try {
      const statementId = String(req.params.statementId);
      const format = String(req.params.format) as ExportFormat;
      if (!VALID.includes(format)) throw new ValidationError(`unknown format ${format}`);
      const allowOverride = req.query.override === 'true';
      // QBO/QFX get auto-split into 200-tx chunks (Phase 22 item 9). When
      // there's only one slice we send it inline; >1 we wrap in a zip so the
      // client gets a single download.
      const slices = await renderExportSlices(db, statementId, format, { allowOverride });
      if (slices.length === 1) {
        const result = slices[0]!;
        await recordExportJob(db, req.user!, statementId, result);
        res.setHeader('content-type', result.contentType);
        res.setHeader('content-disposition', `attachment; filename="${result.filename}"`);
        res.send(result.bytes);
        return;
      }
      const zip = new JSZip();
      for (const r of slices) {
        zip.file(r.filename, r.bytes);
        await recordExportJob(db, req.user!, statementId, r);
      }
      const bytes = await zip.generateAsync({ type: 'nodebuffer' });
      const zipName = slices[0]!.filename.replace(/_part\d+\.[^.]+$/, '') + `-split.zip`;
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-disposition', `attachment; filename="${zipName}"`);
      res.send(bytes);
    } catch (err) {
      next(err);
    }
  });

  // Phase 24 #4: render a format up to the first 30 lines for the
  // ExportPage preview pane. Doesn't persist or audit-log — it's a
  // read-only render-on-demand. Honors override flag like the real
  // export endpoint.
  router.get('/:statementId/exports/:format/preview', async (req, res, next) => {
    try {
      const statementId = String(req.params.statementId);
      const format = String(req.params.format) as ExportFormat;
      if (!VALID.includes(format)) throw new ValidationError(`unknown format ${format}`);
      const allowOverride = req.query.override === 'true';
      const result = await renderExport(db, statementId, format, { allowOverride });
      // Decode as utf-8 — every format we emit is text. (Some sub-formats
      // might be binary one day; if so, fall back to base64 here.)
      const text = result.bytes.toString('utf8');
      const lines = text.split(/\r?\n/);
      const previewLines = lines.slice(0, 30);
      res.json({
        format: result.format,
        filename: result.filename,
        contentType: result.contentType,
        totalLines: lines.length,
        totalBytes: result.bytes.length,
        previewLines,
        truncated: lines.length > 30,
      });
    } catch (err) {
      next(err);
    }
  });

  // Phase 24 #5: list prior exports for a statement so the UI can show
  // "you've downloaded csv-qbo3 3 times" + per-job re-download links.
  router.get('/:statementId/exports', async (req, res, next) => {
    try {
      const statementId = String(req.params.statementId);
      const stmtRows = await db.select().from(statements).where(eq(statements.id, statementId));
      if (stmtRows.length === 0) throw new NotFoundError(`statement ${statementId}`);
      const rows = await db
        .select()
        .from(exportJobs)
        .where(eq(exportJobs.statementId, statementId))
        .orderBy(desc(exportJobs.createdAt));
      res.json(
        rows.map((r) => ({
          id: r.id,
          format: r.format,
          requestedAt: r.createdAt,
          requestedBy: r.requestedBy,
          fileBytes: r.fileBytes,
          intuBidUsed: r.intuBidUsed,
          available: r.filePath !== '<expired>' && r.filePath !== '<pending>',
        })),
      );
    } catch (err) {
      next(err);
    }
  });

  // Bundle download — every format in one zip. Phase 24.
  router.post('/:statementId/exports-bundle', async (req, res, next) => {
    try {
      const statementId = String(req.params.statementId);
      const allowOverride = req.query.override === 'true';
      const zip = new JSZip();
      let lastBaseName: string | null = null;
      for (const fmt of VALID) {
        const slices = await renderExportSlices(db, statementId, fmt, { allowOverride });
        for (const r of slices) {
          zip.file(r.filename, r.bytes);
          await recordExportJob(db, req.user!, statementId, r);
          lastBaseName = r.filename.replace(/(_part\d+)?\.[^.]+$/, '');
        }
      }
      const bytes = await zip.generateAsync({ type: 'nodebuffer' });
      const zipName = `${lastBaseName ?? `statement-${statementId}`}-bundle.zip`;
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-disposition', `attachment; filename="${zipName}"`);
      res.send(bytes);
    } catch (err) {
      next(err);
    }
  });

  return router;
};

// Phase 24 #11: standalone download endpoint for a specific export
// job. Mounted at /api/exports — separate from /api/statements/...
// because the consumer (ExportPage list, audit log re-download) only
// has the job ID. Audit-logs the re-download.
export const exportJobsRouter = (): Router => {
  const router = Router();

  router.get('/:jobId/file', async (req, res, next) => {
    try {
      const jobId = String(req.params.jobId);
      const rows = await db.select().from(exportJobs).where(eq(exportJobs.id, jobId));
      const job = rows[0];
      if (!job) throw new NotFoundError(`export job ${jobId}`);
      if (job.filePath === '<pending>') {
        throw new NotFoundError(`export job ${jobId} is still being written`);
      }
      if (job.filePath === '<expired>') {
        throw new NotFoundError(
          `export job ${jobId} expired (>30 days old) — re-export to refresh`,
        );
      }
      try {
        await stat(job.filePath);
      } catch {
        throw new NotFoundError(`export job ${jobId} file is missing on disk`);
      }
      const ext = job.format.startsWith('csv-') ? 'csv' : job.format;
      const filename = `export-${jobId.slice(0, 8)}.${ext}`;
      const contentType =
        job.format === 'qbo'
          ? 'application/vnd.intu.qbo'
          : job.format === 'qfx'
            ? 'application/vnd.intu.qfx'
            : job.format === 'ofx'
              ? 'application/x-ofx'
              : 'text/csv; charset=utf-8';
      // Phase 25: re-downloads of an exported file leave an audit
      // trail just like the original render. Write before piping so a
      // download that races with a delete still records the attempt.
      await writeAudit(db, {
        actorUserId: req.user!.id,
        entityType: 'statement',
        entityId: job.statementId,
        action: 'statement.export-redownload',
        payload: { exportJobId: jobId, format: job.format, bytes: job.fileBytes },
      });
      res.setHeader('content-type', contentType);
      res.setHeader('content-disposition', `attachment; filename="${filename}"`);
      res.setHeader('content-length', job.fileBytes.toString());
      createReadStream(job.filePath).pipe(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
};
