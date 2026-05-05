import { Router } from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse';

import { db } from '../db/client.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { findByHash, ingestUpload, streamSourcePdf } from '../services/statements.js';
import { checkFreeSpace, isPdfMagicBytes, sha256Of, storePdf } from '../services/upload-storage.js';
import { eq } from 'drizzle-orm';
import { accounts, statements } from '../db/schema.js';

const MAX_PAGES = 200;

const maxBytes = (): number => {
  const mb = Number.parseInt(process.env.MAX_UPLOAD_MB ?? '25', 10);
  return Math.max(1, mb) * 1024 * 1024;
};

const maxBatch = (): number =>
  Math.max(1, Number.parseInt(process.env.MAX_BATCH_SIZE ?? '100', 10));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxBytes(), files: maxBatch() },
});

interface IngestedFile {
  filename: string;
  hash: string;
  pages: number;
  bytes: number;
  storedPath: string;
  statementId: string;
  deduplicated: boolean;
  status: string;
}

interface IngestError {
  filename: string;
  error: string;
}

export const uploadsByAccountRouter = (): Router => {
  const router = Router({ mergeParams: true });

  router.post('/', upload.array('files'), async (req, res, next) => {
    try {
      const accountId = String((req.params as Record<string, string>).accountId ?? '');
      const account = await db.select().from(accounts).where(eq(accounts.id, accountId));
      if (!account[0]) throw new NotFoundError(`account ${accountId} not found`);

      const free = await checkFreeSpace();
      if (free.warn) {
        logger.warn({ freeMb: free.freeMb }, 'low disk space — uploads continuing');
      }

      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) throw new ValidationError('no files uploaded');
      if (files.length > maxBatch()) {
        throw new ValidationError(`batch exceeds ${maxBatch()} files`);
      }

      const ingested: IngestedFile[] = [];
      const errors: IngestError[] = [];

      for (const f of files) {
        try {
          if (!isPdfMagicBytes(f.buffer)) {
            errors.push({ filename: f.originalname, error: 'not a PDF' });
            continue;
          }
          // Page count via pdf-parse; reject > 200 pages.
          let pages = 0;
          try {
            const parsed = await pdfParse(f.buffer);
            pages = parsed.numpages ?? 0;
          } catch (err) {
            errors.push({
              filename: f.originalname,
              error: `unable to parse PDF: ${(err as Error).message}`,
            });
            continue;
          }
          if (pages > MAX_PAGES) {
            errors.push({ filename: f.originalname, error: `> ${MAX_PAGES} pages` });
            continue;
          }
          if (pages < 1) {
            errors.push({ filename: f.originalname, error: 'no pages detected' });
            continue;
          }

          // Hash + dedup pre-check (cheap path before disk write).
          const hash = sha256Of(f.buffer);
          const dup = await findByHash(db, hash);
          if (dup && dup.accountId === accountId) {
            ingested.push({
              filename: f.originalname,
              hash,
              pages,
              bytes: f.size,
              storedPath: dup.sourcePdfPath,
              statementId: dup.id,
              deduplicated: true,
              status: dup.status,
            });
            continue;
          }

          const stored = await storePdf(f.buffer);
          const result = await ingestUpload(db, req.user!, {
            accountId,
            hash: stored.hash,
            storedPath: stored.path,
            filename: f.originalname,
            bytes: stored.bytes,
            pages,
          });

          ingested.push({
            filename: f.originalname,
            hash: stored.hash,
            pages,
            bytes: stored.bytes,
            storedPath: stored.path,
            statementId: result.statement.id,
            deduplicated: result.deduplicated,
            status: result.statement.status,
          });
        } catch (err) {
          if (err instanceof ConflictError) {
            errors.push({ filename: f.originalname, error: err.message });
          } else {
            logger.error({ err, filename: f.originalname }, 'upload ingest failed');
            errors.push({ filename: f.originalname, error: (err as Error).message });
          }
        }
      }

      // Never return raw filesystem paths; expose only the stored hash.
      const safeStatements = ingested.map(({ storedPath: _path, ...rest }) => rest);

      res.status(201).json({
        statements: safeStatements,
        errors,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};

export const uploadsRawRouter = (): Router => {
  const router = Router();

  // Admin-only: streams the original PDF from disk by content hash.
  router.get('/:hash/raw', async (req, res, next) => {
    try {
      if (req.user?.role !== 'admin') throw new ForbiddenError('admin required');
      const hash = String(req.params.hash ?? '').trim();
      if (!/^[0-9a-f]{64}$/.test(hash)) throw new ValidationError('invalid hash');
      const rows = await db.select().from(statements).where(eq(statements.sourcePdfHash, hash));
      const row = rows[0];
      if (!row) throw new NotFoundError(`no statement with hash ${hash}`);
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-disposition', `inline; filename="${hash}.pdf"`);
      streamSourcePdf(row.sourcePdfPath)
        .on('error', (err) => next(err))
        .pipe(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
};
