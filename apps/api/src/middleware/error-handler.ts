import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import {
  AppError,
  InternalError,
  NotFoundError,
  ValidationError,
  isAppError,
  type ErrorCode,
} from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(new NotFoundError(`No route for ${req.method} ${req.path}`));
};

interface ErrorFields {
  status?: unknown;
  statusCode?: unknown;
  expose?: unknown;
  code?: unknown;
  severity?: unknown;
  syscall?: unknown;
  errno?: unknown;
  constraint?: unknown;
  table?: unknown;
}

const fields = (err: unknown): ErrorFields => err as ErrorFields;

interface ClientErrorKind {
  code: ErrorCode;
  name: string;
}

const DEFAULT_CLIENT_ERROR_KIND: ClientErrorKind = { code: 'VALIDATION', name: 'ValidationError' };

const CLIENT_ERROR_KINDS: Record<number, ClientErrorKind> = {
  401: { code: 'AUTH', name: 'AuthError' },
  403: { code: 'FORBIDDEN', name: 'ForbiddenError' },
  404: { code: 'NOT_FOUND', name: 'NotFoundError' },
  409: { code: 'CONFLICT', name: 'ConflictError' },
  429: { code: 'RATE_LIMIT', name: 'RateLimitError' },
};

// The 4xx an http-errors error (body-parser: malformed JSON 400, too large
// 413, bad charset 415; serve-static 404) or Express's own param-decoding
// failure carries. Those set the response status as `statusCode` (and the
// same `status`). Keying on statusCode keeps an upstream status that a
// client library merely records on its error (e.g. an OCR server's 401 as
// `status`) from being replayed to the browser as our own 4xx.
const clientHttpStatus = (err: Error): number | null => {
  const { status, statusCode } = fields(err);
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode)) return null;
  if (statusCode < 400 || statusCode > 499) return null;
  if (status !== undefined && status !== statusCode) return null;
  return statusCode;
};

// pg's DatabaseError: a server-reported failure with a severity and a
// five-character SQLSTATE.
const isPostgresError = (err: Error): boolean => {
  const { severity, code } = fields(err);
  return typeof severity === 'string' && typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
};

// Node system errors (ENOENT, ECONNREFUSED, ...) carry syscall / errno and
// usually a filesystem path or host:port in their message.
const isSystemError = (err: Error): boolean => {
  const { syscall, errno } = fields(err);
  return syscall !== undefined || errno !== undefined;
};

const toAppError = (err: unknown): AppError => {
  if (isAppError(err)) return err;
  if (err instanceof ZodError) return new ValidationError('Validation failed', err.flatten());
  if (!(err instanceof Error)) return new InternalError('Unknown error');

  const httpStatus = clientHttpStatus(err);
  if (httpStatus !== null) {
    const kind = CLIENT_ERROR_KINDS[httpStatus] ?? DEFAULT_CLIENT_ERROR_KIND;
    return new AppError({
      ...kind,
      status: httpStatus,
      message: fields(err).expose === false ? 'Bad request' : err.message,
    });
  }

  if (err.name === 'MulterError') {
    // multer's messages are fixed strings ("File too large", "Unexpected field").
    const tooLarge = fields(err).code === 'LIMIT_FILE_SIZE';
    return new AppError({
      name: 'ValidationError',
      status: tooLarge ? 413 : 400,
      code: 'VALIDATION',
      message: err.message,
    });
  }

  if (isPostgresError(err)) {
    // Generic wording: the driver's own message names constraints, tables
    // and the offending input. The original rides along as the cause so the
    // server log can say which constraint / table it was (see pgLogFields).
    const sqlState = fields(err).code;
    if (sqlState === '23505') {
      return new AppError({
        name: 'ConflictError',
        status: 409,
        code: 'CONFLICT',
        message: 'conflicts with an existing record',
        cause: err,
      });
    }
    if (sqlState === '22P02') {
      return new AppError({
        name: 'ValidationError',
        status: 400,
        code: 'VALIDATION',
        message: 'invalid identifier or value',
        cause: err,
      });
    }
  }

  // In production a driver or system error's text (SQL detail, filesystem
  // paths, host:port) never reaches the client; the log keeps the original
  // as the cause. Other errors keep their message: the admin backup /
  // restore routes surface operator diagnostics through plain Errors.
  const opaque =
    process.env.NODE_ENV === 'production' && (isPostgresError(err) || isSystemError(err));
  return new InternalError(opaque ? 'Internal server error' : err.message, err);
};

// For a Postgres error mapped to a 4xx: which constraint / table it hit, for
// the server log. Never `detail` or the driver message — they quote the
// offending row values / input.
const pgLogFields = (appErr: AppError): Record<string, unknown> => {
  const cause = appErr.cause;
  if (!(cause instanceof Error) || !isPostgresError(cause)) return {};
  const { code, constraint, table } = fields(cause);
  return { pgCode: code, constraint, table };
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appErr = toAppError(err);

  if (appErr.status >= 500) {
    logger.error(
      { err: appErr, requestId: (req as Request).requestId, path: req.path, method: req.method },
      'unhandled error',
    );
  } else {
    logger.warn(
      {
        code: appErr.code,
        ...pgLogFields(appErr),
        requestId: (req as Request).requestId,
        path: req.path,
        method: req.method,
      },
      appErr.message,
    );
  }

  const body: Record<string, unknown> = appErr.toJSON();
  if ((req as Request).requestId) body.requestId = (req as Request).requestId;
  if (process.env.NODE_ENV !== 'production' && appErr.status >= 500 && err instanceof Error) {
    body.stack = err.stack;
  }

  res.status(appErr.status).json(body);
};
