import { Router } from 'express';
import JSZip from 'jszip';

import { db } from '../db/client.js';
import { ValidationError } from '../lib/errors.js';
import { recordExportJob, renderExportSlices, type ExportFormat } from '../services/exports.js';

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
