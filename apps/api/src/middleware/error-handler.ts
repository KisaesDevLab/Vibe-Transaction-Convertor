import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import {
  AppError,
  InternalError,
  NotFoundError,
  ValidationError,
  isAppError,
} from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(new NotFoundError(`No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appErr: AppError;

  if (isAppError(err)) {
    appErr = err;
  } else if (err instanceof ZodError) {
    appErr = new ValidationError('Validation failed', err.flatten());
  } else if (err instanceof Error) {
    appErr = new InternalError(err.message, err);
  } else {
    appErr = new InternalError('Unknown error');
  }

  if (appErr.status >= 500) {
    logger.error(
      { err: appErr, requestId: (req as Request).requestId, path: req.path, method: req.method },
      'unhandled error',
    );
  } else {
    logger.warn(
      {
        code: appErr.code,
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
