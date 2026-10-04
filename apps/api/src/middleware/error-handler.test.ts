import express, { type Express, type RequestHandler } from 'express';
import multer from 'multer';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { errorHandler } from './error-handler.js';

const appWith = (handler: RequestHandler): Express => {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.all('/t', handler);
  app.use(errorHandler);
  return app;
};

const failWith =
  (err: unknown): RequestHandler =>
  (_req, _res, next) =>
    next(err);

const ok: RequestHandler = (_req, res) => {
  res.json({ ok: true });
};

// Shaped like pg's DatabaseError.
const pgError = (code: string, message: string): Error =>
  Object.assign(new Error(message), {
    severity: 'ERROR',
    code,
    detail: 'Key (name)=(Acme LLC) already exists.',
    constraint: 'companies_name_unique',
    table: 'companies',
  });

describe('errorHandler', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('malformed JSON is a 400, not a 500', async () => {
    const res = await request(appWith(ok))
      .post('/t')
      .set('content-type', 'application/json')
      .send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('an oversized JSON body is a 413', async () => {
    const res = await request(appWith(ok))
      .post('/t')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ a: 'x'.repeat(4096) }));
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('VALIDATION');
  });

  it('an unsupported charset is a 415', async () => {
    const res = await request(appWith(ok))
      .post('/t')
      .set('content-type', 'application/json; charset=klingon')
      .send('{}');
    expect(res.status).toBe(415);
  });

  it('multer limits map to 413 (file size) and 400 (anything else)', async () => {
    const tooBig = await request(appWith(failWith(new multer.MulterError('LIMIT_FILE_SIZE')))).post(
      '/t',
    );
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.code).toBe('VALIDATION');

    const unexpected = await request(
      appWith(failWith(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'files'))),
    ).post('/t');
    expect(unexpected.status).toBe(400);
    expect(unexpected.body.code).toBe('VALIDATION');
  });

  it('a unique violation is a 409 that does not echo the constraint or the value', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const err = pgError(
      '23505',
      'duplicate key value violates unique constraint "companies_name_unique"',
    );
    const res = await request(appWith(failWith(err))).post('/t');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(res.body.message).toBe('conflicts with an existing record');
    expect(JSON.stringify(res.body)).not.toMatch(/companies_name_unique|companies|Acme/);

    // The server log names the constraint and table so an operator can tell
    // which one fired — but never the row values in `detail`.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'CONFLICT',
        pgCode: '23505',
        constraint: 'companies_name_unique',
        table: 'companies',
      }),
      'conflicts with an existing record',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Acme|already exists/);
  });

  it('an invalid text representation (e.g. a non-uuid id) is a 400', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const err = pgError('22P02', 'invalid input syntax for type uuid: "abc"');
    const res = await request(appWith(failWith(err))).get('/t');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
    expect(res.body.message).toBe('invalid identifier or value');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'VALIDATION', pgCode: '22P02' }),
      'invalid identifier or value',
    );
    // The driver message quotes the rejected input.
    expect(JSON.stringify(warn.mock.calls)).not.toContain('invalid input syntax');
  });

  it('an upstream status recorded on an error is not replayed as our own 4xx', async () => {
    const upstream = Object.assign(new Error('OCR server returned 401'), { status: 401 });
    const res = await request(appWith(failWith(upstream))).get('/t');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL');
  });

  it('AppErrors pass through unchanged', async () => {
    const res = await request(appWith(failWith(new ForbiddenError('admin required')))).get('/t');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', message: 'admin required' });
  });

  describe('in production', () => {
    it('hides driver and system error text but keeps other messages', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      const db = await request(
        appWith(failWith(pgError('42P01', 'relation "vibetc.secret_table" does not exist'))),
      ).get('/t');
      expect(db.status).toBe(500);
      expect(db.body.message).toBe('Internal server error');
      expect(db.body.stack).toBeUndefined();

      const enoent = Object.assign(
        new Error("ENOENT: no such file or directory, open '/srv/data/uploads/x.pdf'"),
        { errno: -2, code: 'ENOENT', syscall: 'open', path: '/srv/data/uploads/x.pdf' },
      );
      const fs = await request(appWith(failWith(enoent))).get('/t');
      expect(fs.status).toBe(500);
      expect(fs.body.message).toBe('Internal server error');
      expect(JSON.stringify(fs.body)).not.toContain('/srv/data');

      // Operator diagnostics (e.g. a failed restore) stay readable.
      const plain = await request(
        appWith(failWith(new Error('pg_restore failed: role "vibetc_app" does not exist'))),
      ).get('/t');
      expect(plain.status).toBe(500);
      expect(plain.body.message).toMatch(/role "vibetc_app" does not exist/);
    });
  });

  it('outside production a driver error keeps its message for debugging', async () => {
    const res = await request(
      appWith(failWith(pgError('42P01', 'relation "vibetc.nope" does not exist'))),
    ).get('/t');
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/relation "vibetc.nope" does not exist/);
  });
});
