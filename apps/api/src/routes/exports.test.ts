// Export routes — the bundle renders every format before zipping and
// recording anything; `?override=true` is ignored; a download whose file
// vanished or is unreadable answers with a JSON error instead of crashing the
// process. Pure unit test: the DB, the audit writer and the export service are
// mocked, so no Postgres is needed.

import express, { type Request } from 'express';
import JSZip from 'jszip';
import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConflictError } from '../lib/errors.js';
import { errorHandler } from '../middleware/error-handler.js';
import {
  recordExportJob,
  renderExport,
  renderExportSlices,
  type ExportFormat,
  type RenderedExport,
} from '../services/exports.js';
import { exportJobsRouter, exportsRouter } from './exports.js';

const h = vi.hoisted(() => ({
  job: null as Record<string, unknown> | null,
  // Simulates the stat-then-open race: stat says the file exists.
  statSucceeds: false,
}));

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => (h.job ? [h.job] : []),
      }),
    }),
  },
}));
vi.mock('../services/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('../services/exports.js', () => ({
  renderExport: vi.fn(),
  renderExportSlices: vi.fn(),
  recordExportJob: vi.fn(async () => ({ id: 'job', filePath: '/x' })),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual: typeof FsPromises = await importOriginal();
  return {
    ...actual,
    stat: vi.fn(async (p: string) => (h.statSucceeds ? {} : actual.stat(p))),
  };
});

const BASE = 'Bank_1234_2026-03-01_2026-03-31';
const rendered = (format: ExportFormat, filename: string): RenderedExport => ({
  format,
  contentType: 'text/plain',
  filename,
  baseName: BASE,
  bytes: Buffer.from(`${format} bytes`),
});
const uniqueName = (fmt: ExportFormat): string =>
  fmt.startsWith('csv-') ? `${BASE}_${fmt.slice(4)}.csv` : `${BASE}.${fmt}`;

const buildApp = (): express.Express => {
  const app = express();
  app.use((req: Request, _res, next) => {
    req.user = { id: 'u1', role: 'staff' } as NonNullable<Request['user']>;
    next();
  });
  app.use('/api/statements', exportsRouter());
  app.use('/api/exports', exportJobsRouter());
  app.use(errorHandler);
  return app;
};

beforeEach(() => {
  vi.mocked(recordExportJob).mockClear();
  vi.mocked(renderExport).mockReset();
  vi.mocked(renderExportSlices).mockReset();
  h.job = null;
  h.statSucceeds = false;
});

describe('POST /api/statements/:id/exports-bundle', () => {
  it('zips all 7 formats under distinct names, then records 7 jobs', async () => {
    vi.mocked(renderExportSlices).mockImplementation(async (_db, _id, fmt) => [
      rendered(fmt, uniqueName(fmt)),
    ]);
    // responseType('blob') buffers the binary zip body into a Buffer.
    const res = await request(buildApp())
      .post('/api/statements/s1/exports-bundle')
      .responseType('blob');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain(`${BASE}-bundle.zip`);
    const zip = await JSZip.loadAsync(res.body as Buffer);
    expect(Object.keys(zip.files).sort()).toEqual(
      (['csv-qbo3', 'csv-qbo4', 'csv-xero', 'csv-generic', 'ofx', 'qbo', 'qfx'] as const)
        .map(uniqueName)
        .sort(),
    );
    expect(recordExportJob).toHaveBeenCalledTimes(7);
  });

  it('records nothing when a later format fails to render', async () => {
    vi.mocked(renderExportSlices).mockImplementation(async (_db, _id, fmt) => {
      if (fmt === 'ofx') {
        throw new ConflictError('statement has no opening/closing balance — cannot build OFX');
      }
      return [rendered(fmt, uniqueName(fmt))];
    });
    const res = await request(buildApp()).post('/api/statements/s1/exports-bundle');
    expect(res.status).toBe(409);
    expect(recordExportJob).not.toHaveBeenCalled();
  });

  it('refuses (and records nothing) rather than silently overwrite a zip entry', async () => {
    vi.mocked(renderExportSlices).mockImplementation(async (_db, _id, fmt) => [
      rendered(fmt, `${BASE}.csv`),
    ]);
    const res = await request(buildApp()).post('/api/statements/s1/exports-bundle');
    expect(res.status).toBe(500);
    expect(recordExportJob).not.toHaveBeenCalled();
  });
});

describe('export routes ignore ?override=true', () => {
  it('single-format export and preview pass no override to the service', async () => {
    vi.mocked(renderExportSlices).mockResolvedValue([rendered('csv-qbo3', uniqueName('csv-qbo3'))]);
    vi.mocked(renderExport).mockResolvedValue(rendered('csv-qbo3', uniqueName('csv-qbo3')));
    const app = buildApp();

    const exp = await request(app).post('/api/statements/s1/exports/csv-qbo3?override=true');
    expect(exp.status).toBe(200);
    expect(vi.mocked(renderExportSlices).mock.calls[0]).toEqual([
      expect.anything(),
      's1',
      'csv-qbo3',
    ]);

    const preview = await request(app).get(
      '/api/statements/s1/exports/csv-qbo3/preview?override=true',
    );
    expect(preview.status).toBe(200);
    expect(vi.mocked(renderExport).mock.calls[0]).toEqual([expect.anything(), 's1', 'csv-qbo3']);
  });
});

describe('GET /api/exports/:jobId/file', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vibetc-export-dl-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const job = (filePath: string, fileBytes = 10): Record<string, unknown> => ({
    id: 'j1',
    statementId: 's1',
    format: 'csv-qbo3',
    filePath,
    fileBytes,
  });

  it('streams an existing export file', async () => {
    const path = join(dir, 'ok.csv');
    await writeFile(path, 'a,b\r\n1,2\r\n');
    h.job = job(path, 10);
    const res = await request(buildApp()).get('/api/exports/j1/file');
    expect(res.status).toBe(200);
    expect(res.text).toBe('a,b\r\n1,2\r\n');
  });

  it('a file deleted between stat and open → 404 JSON (no crash, no attachment)', async () => {
    h.statSucceeds = true;
    h.job = job(join(dir, 'gone.csv'));
    const res = await request(buildApp()).get('/api/exports/j1/file');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('an unreadable path (EISDIR) → JSON 500 instead of an uncaught stream error', async () => {
    h.job = job(dir); // stat succeeds on a directory; open fails with EISDIR
    const res = await request(buildApp()).get('/api/exports/j1/file');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
  });
});
