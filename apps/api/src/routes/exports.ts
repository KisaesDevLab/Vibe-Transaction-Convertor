import { Router } from 'express';

import { db } from '../db/client.js';
import { ValidationError } from '../lib/errors.js';
import { recordExportJob, renderExport, type ExportFormat } from '../services/exports.js';

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
      const result = await renderExport(db, statementId, format, { allowOverride });
      await recordExportJob(db, req.user!, statementId, result);
      res.setHeader('content-type', result.contentType);
      res.setHeader('content-disposition', `attachment; filename="${result.filename}"`);
      res.send(result.bytes);
    } catch (err) {
      next(err);
    }
  });

  return router;
};
